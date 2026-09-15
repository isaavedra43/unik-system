import type { AgentIdentity } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { wrapUntrusted } from '@/modules/ai/ai-guardrails';
import { checkAgentBudget } from '../budget';
import { cleanText, formatDueLabel, formatDuration } from '../templates';

/**
 * Building blocks of the agent prompts (plan 5.2). Every prompt is a list of
 * sections: static rules written by UNIK (trusted) and data lines (names,
 * titles, customer/vendor data, human free text) that always go inside a
 * `wrapUntrusted` block. `renderSections` keeps the prompt under its budget by
 * dropping data lines from the lowest-priority sections first, never cutting
 * through an untrusted block.
 */

/** ≈1.2k tokens for a surface prompt (Spanish ≈ 4 characters per token). */
export const PROMPT_MAX_CHARS = 4800;
/** ≈600 tokens for the agent base prompt. */
export const BASE_PROMPT_MAX_CHARS = 2400;
/** Default longest data line. */
export const PROMPT_LINE_MAX = 240;

export interface PromptSection {
  title: string;
  /** Trusted static instructions. */
  rules?: string[];
  /** Untrusted data lines; `undefined` = the section has no data block. */
  data?: string[];
  /** `source` attribute of the untrusted block. */
  source?: string;
  /** Lower priorities lose their data lines first. */
  priority?: number;
  /** Text shown when `data` is empty. */
  empty?: string;
  /** Longest data line of this section (default PROMPT_LINE_MAX). */
  lineMax?: number;
  /** Real total when `data` is already a sample (shows "… y N más"). */
  total?: number;
}

function clip(line: string, max: number): string {
  const text = line.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

interface SectionState {
  section: PromptSection;
  lines: string[];
  omitted: number;
}

function renderSection(state: SectionState): string {
  const { section, lines } = state;
  const parts = [`## ${section.title}`];
  if (section.rules?.length) parts.push(...section.rules);
  if (section.data !== undefined) {
    if (lines.length === 0 && state.omitted === 0) {
      parts.push(section.empty ?? 'Sin datos.');
    } else if (lines.length === 0) {
      parts.push(`(${state.omitted} registros omitidos por espacio; consúltalos con tus tools)`);
    } else {
      const body = state.omitted > 0 ? [...lines, `… y ${state.omitted} más`] : lines;
      parts.push(wrapUntrusted(body.join('\n'), section.source ?? 'datos'));
    }
  }
  return parts.join('\n');
}

/** Renders the sections within `maxChars`, trimming data lines by priority. */
export function renderSections(sections: PromptSection[], maxChars: number = PROMPT_MAX_CHARS): string {
  const states: SectionState[] = sections.map((section) => {
    const lines = (section.data ?? []).map((line) => clip(line, section.lineMax ?? PROMPT_LINE_MAX)).filter(Boolean);
    const extra = typeof section.total === 'number' ? Math.max(0, section.total - lines.length) : 0;
    return { section, lines, omitted: extra };
  });
  const render = () => states.map(renderSection).join('\n\n');
  let out = render();
  while (out.length > maxChars) {
    const target = states
      .filter((s) => s.lines.length > 0)
      .sort(
        (a, b) =>
          (a.section.priority ?? 0) - (b.section.priority ?? 0) || b.lines.length - a.lines.length
      )[0];
    if (!target) break;
    target.lines.pop();
    target.omitted += 1;
    out = render();
  }
  // Only trusted text is left at this point (no untrusted block can be cut).
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/** Runs a loader; a failure degrades to `fallback` (a prompt never breaks the turn). */
export async function safe<T>(label: string, loader: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await loader();
  } catch (err) {
    console.warn(
      JSON.stringify({
        component: 'agents-prompts',
        event: 'loader_failed',
        label,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return fallback;
  }
}

export const text = cleanText;

/** Names of users by id (missing ids are simply absent). */
export async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: unique.slice(0, 200) } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Case number and sales order of each case id. */
export async function caseRefs(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.operationalCase.findMany({
    where: { id: { in: unique.slice(0, 200) } },
    select: { id: true, caseNumber: true, salesOrderNumber: true },
  });
  return new Map(
    rows.map((row) => [row.id, row.salesOrderNumber ? `${row.caseNumber}/${row.salesOrderNumber}` : row.caseNumber])
  );
}

/** "hoy 17:00" / "18 sep 17:00". */
export function due(date: Date | string | null | undefined, now: Date): string {
  return formatDueLabel(date, now);
}

/** "vencido hace 2 h" when `dueAt` already passed; empty otherwise. */
export function overdueLabel(dueAt: Date | string | null | undefined, now: Date, word = 'vencido'): string {
  if (!dueAt) return '';
  const time = new Date(dueAt).getTime();
  if (Number.isNaN(time) || time >= now.getTime()) return '';
  const late = formatDuration((now.getTime() - time) / 60_000);
  return late ? `${word} hace ${late}` : word;
}

export function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
}

const STATE_LABELS = { ok: 'normal', degraded: 'degradado (sólo bajo demanda)', exhausted: 'agotado (en pausa)' } as const;

/** "Presupuesto de hoy: 12,300 de 150,000 tokens (8 %) · estado normal". */
export async function budgetLine(identity: AgentIdentity | null): Promise<string | null> {
  if (!identity) return null;
  const status = await checkAgentBudget(identity);
  const limit = status.dailyTokenBudget > 0 ? status.dailyTokenBudget.toLocaleString('es-MX') : 'sin límite de';
  return `Presupuesto de hoy de ${identity.displayName}: ${status.tokensToday.toLocaleString('es-MX')} de ${limit} tokens (${Math.round(status.pct)} %) · estado ${STATE_LABELS[status.state]} · modo ${identity.mode}`;
}

/** Responsible and backup of an area as a data line. */
export async function responsibleLine(areaKey: string): Promise<string> {
  const area = await prisma.area.findUnique({
    where: { key: areaKey },
    select: { label: true, responsibleArea: true, leadUserId: true },
  });
  const responsible = await prisma.responsible.findUnique({
    where: { area: area?.responsibleArea || areaKey },
    select: { userId: true, backupUserId: true, active: true },
  });
  const names = await userNames([responsible?.userId, responsible?.backupUserId, area?.leadUserId]);
  const parts: string[] = [];
  if (responsible?.active) {
    const owner = names.get(responsible.userId) ?? 'sin nombre';
    const backup = responsible.backupUserId ? names.get(responsible.backupUserId) : null;
    parts.push(`Responsable: ${owner}${backup ? ` (suplente ${backup})` : ' (sin suplente)'}`);
  } else {
    parts.push('Responsable: sin configurar (el trabajo cae al líder, a Administración o al super administrador)');
  }
  if (area?.leadUserId && names.get(area.leadUserId)) parts.push(`Líder: ${names.get(area.leadUserId)}`);
  return parts.join(' · ');
}
