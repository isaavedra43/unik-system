import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ToolEffect } from '@/modules/ai/tools/registry';
import { acquireVenue } from './venue-manager';
import type { BrowserActInput } from './venue';

/**
 * Venue playbooks — recorded flows a routine can replay without improvising:
 * "login GPS → unidades → extract → compare geofences → report". The user
 * approves the playbook once; runs of approved playbooks still classify their
 * effect per step (a run containing submit/credentials asks again).
 */

export interface PlaybookStep {
  /** browserAct action, or 'exec' for a sandbox shell command. */
  action: BrowserActInput['action'] | 'exec';
  url?: string;
  selector?: string;
  text?: string;
  command?: string;
  key?: string;
  extractMode?: string;
  /** Optional assertion: substring expected in the result content. */
  expect?: string;
  note?: string;
}

const MAX_STEPS = 40;
const MAX_STEP_RESULT = 4000;

export function sanitizeSteps(raw: unknown): PlaybookStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STEPS).map((s) => {
    const step = (s ?? {}) as Record<string, unknown>;
    return {
      action: String(step.action ?? '') as PlaybookStep['action'],
      url: typeof step.url === 'string' ? step.url : undefined,
      selector: typeof step.selector === 'string' ? step.selector : undefined,
      text: typeof step.text === 'string' ? step.text : undefined,
      command: typeof step.command === 'string' ? step.command : undefined,
      key: typeof step.key === 'string' ? step.key : undefined,
      extractMode: typeof step.extractMode === 'string' ? step.extractMode : undefined,
      expect: typeof step.expect === 'string' ? step.expect.slice(0, 200) : undefined,
      note: typeof step.note === 'string' ? step.note.slice(0, 200) : undefined,
    };
  }).filter((s) => s.action);
}

/**
 * Static effect of a playbook run — the strongest effect of any step:
 * credentials/submits are external sends, exec can mutate, the rest is internal.
 * Used by `resolveEffect` so approval is asked before the run starts.
 */
export function playbookEffect(steps: PlaybookStep[]): ToolEffect {
  if (steps.some((s) => s.action === 'submit' || s.action === 'useCredential')) return 'external_send';
  if (steps.some((s) => s.action === 'exec' || s.action === 'type' || s.action === 'click' || s.action === 'press')) return 'business_write';
  return 'read';
}

/** {{param}} interpolation in string fields. Pure. */
export function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => params[key] ?? `{{${key}}}`);
}

export async function savePlaybook(
  actor: CurrentUser,
  input: { name: string; steps: PlaybookStep[]; params?: Record<string, unknown>; requiresHost?: string }
): Promise<{ id: string; status: string }> {
  const row = await prisma.venuePlaybook.create({
    data: {
      userId: actor.id,
      name: input.name.slice(0, 120),
      steps: input.steps as unknown as Prisma.InputJsonValue,
      params: (input.params ?? {}) as Prisma.InputJsonValue,
      requiresHost: input.requiresHost ?? null,
      status: 'pending',
    },
  });
  return { id: row.id, status: row.status };
}

export async function approvePlaybook(userId: string, id: string, accept: boolean): Promise<boolean> {
  const res = await prisma.venuePlaybook.updateMany({
    where: { id, userId, status: 'pending' },
    data: { status: accept ? 'active' : 'archived' },
  });
  return res.count > 0;
}

export async function listPlaybooks(userId: string) {
  return prisma.venuePlaybook.findMany({
    where: { userId, status: { not: 'archived' } },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, name: true, status: true, requiresHost: true, runCount: true, lastRunAt: true, params: true, steps: true },
  });
}

export interface PlaybookRunResult {
  ok: boolean;
  completedSteps: number;
  failedStep?: number;
  results: Array<{ step: number; action: string; ok: boolean; content?: string; error?: string }>;
}

/**
 * Executes an approved playbook against the user's venue. Params fill `{{x}}`
 * placeholders; each step's result is truncated into the run report. Secrets
 * are never part of playbook steps — useCredential steps reference a
 * credentialId resolved by the venue layer at run time.
 */
export async function runPlaybook(
  actor: CurrentUser,
  playbookId: string,
  params: Record<string, string>
): Promise<PlaybookRunResult> {
  const row = await prisma.venuePlaybook.findFirst({ where: { id: playbookId, userId: actor.id } });
  if (!row) throw new Error('Playbook no encontrado.');
  if (row.status !== 'active') throw new Error(`El playbook está "${row.status}" — el usuario debe aprobarlo primero.`);

  const steps = sanitizeSteps(row.steps);
  const venue = await acquireVenue({ userId: actor.id, purpose: `playbook:${row.name}` });
  const results: PlaybookRunResult['results'] = [];

  let failedStep: number | undefined;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      if (step.action === 'exec') {
        const res = await venue.exec(interpolate(step.command ?? '', params), { timeoutSec: 120 });
        const content = res.stdout.slice(0, MAX_STEP_RESULT);
        const ok = res.exitCode === 0 && (!step.expect || content.includes(step.expect));
        results.push({ step: i + 1, action: 'exec', ok, content });
        if (!ok) { failedStep = i + 1; break; }
      } else {
        const res = await venue.browserAct({
          action: step.action,
          url: step.url ? interpolate(step.url, params) : undefined,
          selector: step.selector ? interpolate(step.selector, params) : undefined,
          text: step.text ? interpolate(step.text, params) : undefined,
          key: step.key,
          extractMode: step.extractMode,
        });
        const content = (res.content ?? res.url ?? '').slice(0, MAX_STEP_RESULT);
        const ok = res.ok && (!step.expect || content.includes(step.expect));
        results.push({ step: i + 1, action: step.action, ok, content, error: res.error });
        if (!ok) { failedStep = i + 1; break; }
      }
    } catch (err) {
      results.push({
        step: i + 1,
        action: step.action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      failedStep = i + 1;
      break;
    }
  }

  await prisma.venuePlaybook.update({
    where: { id: row.id },
    data: { runCount: { increment: 1 }, lastRunAt: new Date() },
  }).catch(() => undefined);

  return {
    ok: failedStep === undefined,
    completedSteps: results.filter((r) => r.ok).length,
    failedStep,
    results,
  };
}
