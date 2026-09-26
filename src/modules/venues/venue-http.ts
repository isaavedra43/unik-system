import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import type { PlaybookStep } from './venue-playbooks';
import type { BrowserActInput, BrowserActResult } from './venue';

/**
 * Shared plumbing for the workspace routes (/app/assistant/api/venue/*):
 * auth + permission, the caller's live session row, no-store responses and
 * the "Enséñale" (teach) recorder that turns a user demonstration in the
 * live browser into a replayable playbook.
 */

/** Home of the default Daytona user — where the file browser opens. */
export const DEFAULT_VENUE_HOME = '/home/daytona';

/** Screens are ephemeral: frames live only in the response, never cached. */
export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
} as const;

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export type VenuePermission = 'browser.use' | 'venue.exec' | 'venue.files';

export async function requireVenueUser(
  permission: VenuePermission
): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const session = await getCurrentSession();
  if (!session) return { response: json({ error: 'No autenticado' }, 401) };
  if (!hasPermission(session.user, permission)) {
    return { response: json({ error: 'Sin permiso' }, 403) };
  }
  return { user: session.user };
}

export interface PendingSecureInput {
  id: string;
  fields: { selector?: string; ref?: number; label: string; sensitive?: boolean }[];
  message?: string | null;
  ts: string;
}

export interface TeachState {
  recording: boolean;
  startedAt: string;
  steps: PlaybookStep[];
}

export function metaOf(row: { metadata: unknown } | null | undefined): Record<string, unknown> {
  return (row?.metadata as Record<string, unknown> | null) ?? {};
}

export function pendingInputsOf(meta: Record<string, unknown>) {
  const cutoff = Date.now() - 30 * 60_000;
  return ((meta.pendingSecureInputs as PendingSecureInput[] | undefined) ?? [])
    .filter((r) => new Date(r.ts).getTime() > cutoff)
    .map((r) => ({
      requestId: r.id,
      message: r.message ?? null,
      fields: (r.fields ?? []).map((f) => ({
        key: fieldKey(f),
        label: f.label,
        sensitive: f.sensitive === true,
      })),
    }));
}

/** Stable key of a secure-input field: its selector, or its snapshot ref. */
export function fieldKey(f: { selector?: string; ref?: number }): string {
  return f.selector ? f.selector : `ref:${f.ref ?? '?'}`;
}

export function teachOf(meta: Record<string, unknown>): TeachState | null {
  const t = meta.teach as TeachState | undefined;
  return t && t.recording ? t : null;
}

const MAX_TEACH_STEPS = 40;

/**
 * Turns one user takeover action into a playbook step. Clicks are recorded by
 * the element they hit (selector + visible text), never by coordinates; text
 * typed into a password field becomes a `{{contrasena}}` parameter — the
 * secret itself is never stored.
 */
export function stepFromTakeover(
  input: BrowserActInput,
  result: BrowserActResult
): PlaybookStep | null {
  switch (input.action) {
    case 'open':
    case 'newTab':
      return result.url ? { action: 'open', url: result.url } : null;
    case 'back':
    case 'forward':
    case 'reload':
      return { action: input.action };
    case 'clickAt':
      return result.hit?.selector
        ? { action: 'click', selector: result.hit.selector, note: result.hit.text || undefined }
        : null;
    case 'typeText':
      if (!result.hit?.selector) return null;
      return {
        action: 'type',
        selector: result.hit.selector,
        text: result.hit.sensitive ? '{{contrasena}}' : String(input.text ?? ''),
      };
    case 'key':
      return input.key === 'Enter' || input.key === 'Tab' || input.key === 'Escape'
        ? { action: 'press', key: input.key }
        : null;
    default:
      return null;
  }
}

/** Append a step to the live recording (merging consecutive typing into one field). */
export async function recordTeachStep(sessionId: string, step: PlaybookStep): Promise<number> {
  const row = await prisma.venueSession.findUnique({ where: { id: sessionId } });
  const meta = metaOf(row);
  const teach = teachOf(meta);
  if (!teach) return 0;
  const steps = [...teach.steps];
  const last = steps[steps.length - 1];
  if (
    step.action === 'type' &&
    last?.action === 'type' &&
    last.selector === step.selector &&
    step.text !== '{{contrasena}}' &&
    last.text !== '{{contrasena}}'
  ) {
    last.text = `${last.text ?? ''}${step.text ?? ''}`;
  } else if (steps.length < MAX_TEACH_STEPS) {
    steps.push(step);
  }
  await prisma.venueSession.update({
    where: { id: sessionId },
    data: {
      metadata: { ...meta, teach: { ...teach, steps } } as unknown as Prisma.InputJsonValue,
    },
  });
  return steps.length;
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.venueSession
    .update({ where: { id: sessionId }, data: { status: 'active', lastUsedAt: new Date() } })
    .catch(() => undefined);
}

/** Frame payload for the client (data URL + page state). */
export function browserFramePayload(r: BrowserActResult) {
  return {
    ok: r.ok,
    error: r.error ?? null,
    frame: r.screenshotBase64 ? `data:image/jpeg;base64,${r.screenshotBase64}` : null,
    url: r.url ?? null,
    title: r.title ?? null,
    tabs: r.tabs ?? null,
    viewport: r.viewport ?? null,
    sensitive: r.frameSensitive === true,
    empty: r.empty === true,
  };
}
