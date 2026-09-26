import { prisma } from '@/lib/prisma';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { recordUsage } from '@/modules/extensions/usage-meter';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import {
  encryptSecret,
  decryptSecret,
  isSecretsConfigured,
  maskSecret,
} from '@/modules/extensions/secrets';
import {
  DaytonaVenue,
  venueEnvName,
  type AttachOptions,
  type DaytonaVenueConfig,
} from './daytona-venue';
import type { Venue } from './venue';

/**
 * Venue lifecycle manager — the only place sessions are created/destroyed.
 *
 * Invariants:
 *   - venueEnabled + UNIK_VENUE_ENABLED gate everything (double kill-switch)
 *   - venueMaxConcurrent caps live sandboxes; venueMaxMinutesPerDay caps spend
 *   - sessions are per-user today; the future mission layer passes missionId
 *   - every acquire/release bills minutes to UsageMeter dim 'venue'
 *   - controller tokens live in VenueSession.metadata (internal only)
 *   - BrowserProfile storageState is AES-256-GCM ciphertext — never plaintext
 */

export class VenueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenueUnavailableError';
  }
}

async function daytonaConfig(): Promise<DaytonaVenueConfig | null> {
  const settings = await getAiSettings();
  if (!settings.venueEnabled) return null;
  if (process.env.UNIK_VENUE_ENABLED === 'false') return null;
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL?.trim() || undefined,
    // No default snapshot: a named snapshot that doesn't exist in this Daytona
    // account wastes a whole create attempt before the fallback. The browser
    // stack is provisioned inside whatever image Daytona gives us.
    image: settings.venueImage?.trim() || undefined,
    target: process.env.DAYTONA_TARGET?.trim() || undefined,
    autoStopMinutes: settings.venueIdleTimeoutMinutes || 15,
    domainAllowList: mergedDomainAllowList(settings.webDomainAllowlist ?? []),
  };
}

/**
 * The allowlist exists to constrain where the AGENT browses — not the VM's own
 * provisioning. Without these infra hosts an admin allowlist silently kills
 * `provision.sh` (no node/npm/chromium) and every browser action then fails
 * with a confusing "controller down" error.
 */
const PROVISION_HOSTS = [
  'nodejs.org',
  'registry.npmjs.org',
  'deb.debian.org',
  'security.debian.org',
  'ftp.debian.org',
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'cdn.playwright.dev',
  'playwright.azureedge.net',
  'playwright-akamai.azureedge.net',
  'playwright-verizon.azureedge.net',
];

function mergedDomainAllowList(allowlist: string[]): string[] {
  const userHosts = allowlist.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (userHosts.length === 0) return []; // empty → param omitted → unrestricted
  return [...new Set([...userHosts, ...PROVISION_HOSTS])];
}

export async function isVenueEnabled(): Promise<boolean> {
  return (await daytonaConfig()) !== null;
}

function minutesBetween(a: Date, b: Date): number {
  return Math.max(1, Math.ceil((b.getTime() - a.getTime()) / 60_000));
}

/** Emit a live event for the future "pantalla del agente" feed (SSE). */
export async function emitVenueEvent(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await publishRealtime(`venue:${sessionId}`, type, payload);
  } catch {
    // feed is best-effort; never block work on it
  }
}

async function billMinutes(sessionId: string, userId: string, minutes: number): Promise<void> {
  await prisma.venueSession
    .update({
      where: { id: sessionId },
      data: { billedMinutes: { increment: minutes } },
    })
    .catch(() => undefined);
  await recordUsage('venue', userId, 'minutes', minutes).catch(() => undefined);
}

async function dailyVenueMinutes(): Promise<number> {
  const period = new Date().toISOString().slice(0, 10);
  const rows = await prisma.usageMeter.findMany({
    where: { dimension: 'venue', period, unit: 'minutes' },
    select: { amount: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

/**
 * Returns a live Venue for this user — reusing their active session or
 * creating a new sandbox (budget + concurrency checked). Throws
 * VenueUnavailableError with a user-safe reason when it can't.
 */
export async function acquireVenue(input: {
  userId: string;
  purpose?: string;
  /**
   * 'background' — answer as soon as the sandbox exists and prepare the
   * browser stack behind the scenes (the panel's power button). Tool calls
   * keep the default: wait until the browser is ready.
   */
  warm?: 'await' | 'background';
}): Promise<Venue> {
  const cfg = await daytonaConfig();
  if (!cfg) {
    throw new VenueUnavailableError(
      'La computadora virtual está desactivada o falta DAYTONA_API_KEY.'
    );
  }
  const settings = await getAiSettings();
  // Only browser work waits for Chromium; terminal, files and desktop answer as
  // soon as the sandbox runs (the browser keeps preparing in the background and
  // browserAct heals itself on first use).
  const needsBrowser = /^(browser|playbook|screenshot|analyze)/.test(input.purpose ?? '');
  const attachOpts: AttachOptions =
    input.warm === 'background' || !needsBrowser ? { heal: false, wake: true } : {};
  const warm = input.warm ?? (needsBrowser ? 'await' : 'background');

  // Reuse the user's most recent active session when the sandbox is still up.
  const existing = await prisma.venueSession.findFirst({
    where: { userId: input.userId, status: { in: ['active', 'idle'] } },
    orderBy: { lastUsedAt: 'desc' },
  });
  if (existing?.externalId) {
    try {
      const token =
        (existing.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
      const venue = await DaytonaVenue.attach(
        existing.id,
        existing.externalId,
        cfg,
        token,
        attachOpts
      );
      await prisma.venueSession.update({
        where: { id: existing.id },
        data: { status: 'active', lastUsedAt: new Date() },
      });
      return venue;
    } catch {
      // Sandbox is gone or broken — retire the row and fall through to create.
      await prisma.venueSession
        .update({
          where: { id: existing.id },
          data: { status: 'error', endedAt: new Date() },
        })
        .catch(() => undefined);
    }
  }

  const [liveCount, usedMinutes] = await Promise.all([
    prisma.venueSession.count({ where: { status: { in: ['active', 'idle'] } } }),
    dailyVenueMinutes(),
  ]);
  if (liveCount >= (settings.venueMaxConcurrent || 2)) {
    throw new VenueUnavailableError(
      `Límite de computadoras virtuales simultáneas alcanzado (${settings.venueMaxConcurrent}).`
    );
  }
  if (usedMinutes >= (settings.venueMaxMinutesPerDay || 60)) {
    throw new VenueUnavailableError(
      `Presupuesto diario de computadora virtual agotado (${settings.venueMaxMinutesPerDay} min).`
    );
  }

  // Reuse the user's previous (stopped/archived) sandbox before creating a new
  // one: files survive between sessions and the org never piles up sandboxes
  // (every stopped one counts against Daytona's disk quota).
  const previous = await prisma.venueSession.findFirst({
    where: {
      userId: input.userId,
      status: 'stopped',
      externalId: { not: null },
      endedAt: { gte: new Date(Date.now() - REUSE_WINDOW_MS) },
    },
    orderBy: { endedAt: 'desc' },
  });
  if (previous?.externalId) {
    try {
      const token =
        (previous.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
      const venue = await DaytonaVenue.attach(
        previous.id,
        previous.externalId,
        cfg,
        token,
        attachOpts
      );
      await prisma.venueSession.update({
        where: { id: previous.id },
        data: {
          status: 'active',
          endedAt: null,
          lastUsedAt: new Date(),
          purpose: input.purpose ?? previous.purpose,
        },
      });
      await emitVenueEvent(previous.id, 'session_resumed', { externalId: previous.externalId });
      return venue;
    } catch (err) {
      console.warn(
        '[venue] previous sandbox could not be resumed:',
        err instanceof Error ? err.message : err
      );
      await prisma.venueSession
        .update({ where: { id: previous.id }, data: { status: 'error' } })
        .catch(() => undefined);
    }
  }

  const session = await prisma.venueSession.create({
    data: {
      userId: input.userId,
      kind: 'daytona',
      status: 'active',
      purpose: input.purpose ?? null,
    },
  });
  const persist = async (externalId: string, controllerToken: string) => {
    await prisma.venueSession.update({
      where: { id: session.id },
      data: { externalId, metadata: { controllerToken } },
    });
  };
  const create = () => DaytonaVenue.create(session.id, cfg, { warm, onCreated: persist });
  try {
    let venue: Venue;
    try {
      venue = await create();
    } catch (err) {
      // Daytona answers "Total disk limit exceeded" when stopped sandboxes fill
      // the org quota: free disk (archive the reusable one per user, delete the
      // rest of ours) and try once more.
      if (!isQuotaError(err)) throw err;
      const freed = await reclaimVenueDisk({ aggressive: true, cfg });
      console.warn('[venue] quota hit, reclaimed disk:', freed);
      if (freed.archived + freed.deleted === 0) throw err;
      venue = await create();
    }
    await emitVenueEvent(session.id, 'session_started', {
      externalId: venue.externalId,
      purpose: input.purpose,
    });
    return venue;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[venue] create failed:', err);
    const row = await prisma.venueSession
      .findUnique({ where: { id: session.id } })
      .catch(() => null);
    await prisma.venueSession.update({
      where: { id: session.id },
      data: {
        status: 'error',
        endedAt: new Date(),
        metadata: {
          ...((row?.metadata as Record<string, unknown> | null) ?? {}),
          error: reason.slice(0, 300),
        },
      },
    });
    // A sandbox that exists but failed to get ready must not stay alive.
    if (row?.externalId) void DaytonaVenue.dispose(cfg, row.externalId, 'delete');
    throw new VenueUnavailableError(
      isQuotaError(err)
        ? 'Daytona no tiene espacio para otra computadora (límite de disco de la organización). Libera o archiva sandboxes en app.daytona.io o sube de plan.'
        : `No se pudo crear la computadora virtual: ${reason}`
    );
  }
}

/** Sessions resumed instead of recreated while their sandbox still exists. */
const REUSE_WINDOW_MS = 3 * 24 * 60 * 60_000;

const QUOTA_RE =
  /disk limit|storage limit|quota|limit exceeded|insufficient (disk|storage)|no space/i;

export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return QUOTA_RE.test(msg);
}

const ORPHAN_AGE_MS = 6 * 60 * 60_000;
const AGGRESSIVE_ORPHAN_AGE_MS = 30 * 60_000;
let lastReclaimAt = 0;

/**
 * Keeps the Daytona org under its disk quota. For OUR sandboxes only (label
 * `unik-session`, same environment label):
 *   - live sessions (active/idle) are never touched;
 *   - the most recent stopped sandbox of each user is ARCHIVED (keeps files,
 *     frees disk) so the next session resumes it;
 *   - older stopped ones, errored ones and orphans (no DB row, older than a
 *     grace period) are DELETED.
 */
export async function reclaimVenueDisk(
  opts: { aggressive?: boolean; cfg?: DaytonaVenueConfig | null } = {}
): Promise<{ archived: number; deleted: number }> {
  const cfg = opts.cfg ?? (await daytonaConfig());
  const result = { archived: 0, deleted: 0 };
  if (!cfg) return result;
  lastReclaimAt = Date.now();
  let own;
  try {
    own = await DaytonaVenue.listOwn(cfg);
  } catch (err) {
    console.warn('[venue] could not list sandboxes:', err instanceof Error ? err.message : err);
    return result;
  }
  const env = venueEnvName();
  const mine = own.filter((sb) => !sb.env || sb.env === env);
  if (mine.length === 0) return result;
  const rows = await prisma.venueSession.findMany({
    where: { externalId: { in: mine.map((sb) => sb.id) } },
    select: { id: true, userId: true, status: true, externalId: true, endedAt: true },
  });
  const byExternal = new Map(rows.map((r) => [r.externalId as string, r]));
  const latestStopped = new Map<string, string>();
  for (const r of [...rows]
    .filter((r) => r.status === 'stopped')
    .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0))) {
    if (!latestStopped.has(r.userId)) latestStopped.set(r.userId, r.externalId as string);
  }
  const orphanAge = opts.aggressive ? AGGRESSIVE_ORPHAN_AGE_MS : ORPHAN_AGE_MS;
  for (const sb of mine) {
    if (/^(archived|archiving|destroyed|destroying)$/.test(sb.state)) continue;
    const row = byExternal.get(sb.id);
    if (row && (row.status === 'active' || row.status === 'idle')) continue;
    if (!row && Date.now() - sb.touchedAt < orphanAge) continue; // may be mid-creation
    const reusable = row && latestStopped.get(row.userId) === sb.id;
    if (reusable) {
      if (await DaytonaVenue.dispose(cfg, sb.id, 'archive')) result.archived++;
    } else if (await DaytonaVenue.dispose(cfg, sb.id, 'delete')) {
      result.deleted++;
      if (row) {
        await prisma.venueSession
          .update({
            where: { id: row.id },
            data: { status: 'deleted', endedAt: row.endedAt ?? new Date() },
          })
          .catch(() => undefined);
      }
    }
  }
  return result;
}

/** Reattach to a specific session (tool calls carry sessionId). */
export async function attachVenue(
  sessionId: string,
  userId: string,
  opts: AttachOptions = {}
): Promise<Venue> {
  const session = await prisma.venueSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    throw new VenueUnavailableError('Sesión de computadora virtual no encontrada.');
  }
  if (session.status !== 'active' && session.status !== 'idle') {
    throw new VenueUnavailableError(
      'La sesión de computadora virtual ya terminó — pide una nueva con el venue.'
    );
  }
  const cfg = await daytonaConfig();
  if (!cfg || !session.externalId) throw new VenueUnavailableError('Venue no disponible.');
  const token = (session.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
  const venue = await DaytonaVenue.attach(session.id, session.externalId, cfg, token, opts);
  // A passive poll (heal:false) must not count as "use" — otherwise watching
  // the panel keeps the sandbox alive forever and the idle reaper never fires.
  if (opts.heal !== false) {
    await prisma.venueSession.update({
      where: { id: session.id },
      data: { status: 'active', lastUsedAt: new Date() },
    });
  }
  return venue;
}

/** The user's live session row, if any (the panel and the session route share it). */
export async function currentVenueSession(userId: string) {
  return prisma.venueSession.findFirst({
    where: { userId, status: { in: ['active', 'idle'] } },
    orderBy: { lastUsedAt: 'desc' },
  });
}

/** Panel "Apagar": stop the user's live sandbox (bills elapsed minutes). No-op without one. */
export async function stopUserVenue(userId: string): Promise<boolean> {
  const session = await currentVenueSession(userId);
  if (!session) return false;
  await releaseVenue(session.id);
  return true;
}

/** Mark the session idle and stop the sandbox (bills elapsed minutes). */
export async function releaseVenue(sessionId: string): Promise<void> {
  const session = await prisma.venueSession.findUnique({ where: { id: sessionId } });
  if (!session || (session.status !== 'active' && session.status !== 'idle')) return;
  await billMinutes(session.id, session.userId, minutesBetween(session.lastUsedAt, new Date()));
  const cfg = await daytonaConfig();
  if (cfg && session.externalId) {
    try {
      const token =
        (session.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
      const venue = await DaytonaVenue.attach(session.id, session.externalId, cfg, token);
      await venue.stop();
    } catch {
      // sandbox may already be gone — still mark the session
    }
  }
  await prisma.venueSession.update({
    where: { id: session.id },
    data: { status: 'stopped', endedAt: new Date() },
  });
  await emitVenueEvent(session.id, 'session_stopped', {});
}

/** Killswitch: destroy the sandbox immediately. */
export async function endVenueSession(sessionId: string): Promise<void> {
  const session = await prisma.venueSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  const cfg = await daytonaConfig();
  if (cfg && session.externalId) {
    try {
      const venue = await DaytonaVenue.attach(session.id, session.externalId, cfg, '');
      await venue.destroy();
    } catch {
      // best-effort destroy; the row is what matters
    }
  }
  await prisma.venueSession.update({
    where: { id: session.id },
    data: { status: 'stopped', endedAt: new Date() },
  });
  await emitVenueEvent(session.id, 'session_destroyed', {});
}

/** Reaper: stop sessions idle longer than venueIdleTimeoutMinutes. */
export async function reapIdleVenues(): Promise<{ reaped: number }> {
  const settings = await getAiSettings();
  const idleMs = (settings.venueIdleTimeoutMinutes || 15) * 60_000;
  const cutoff = new Date(Date.now() - idleMs);
  const stale = await prisma.venueSession.findMany({
    where: { status: { in: ['active', 'idle'] }, lastUsedAt: { lt: cutoff } },
    select: { id: true },
    take: 20,
  });
  let reaped = 0;
  for (const s of stale) {
    await releaseVenue(s.id);
    reaped++;
  }
  // Disk hygiene at most every 30 min: archive/delete stopped sandboxes so the
  // org quota never fills up again.
  if (Date.now() - lastReclaimAt > 30 * 60_000) {
    await reclaimVenueDisk().catch(() => undefined);
  }
  return { reaped };
}

// ---------------------------------------------------------------------------
// Browser profiles — encrypted per-host session state (cookies/localStorage)
// ---------------------------------------------------------------------------

export async function saveBrowserProfile(input: {
  userId: string;
  name: string;
  host: string;
  stateJson: string;
}): Promise<{ id: string }> {
  if (!isSecretsConfigured()) {
    throw new VenueUnavailableError(
      'El vault de secretos no está configurado (UNIK_SECRETS_MASTER_KEY).'
    );
  }
  const encrypted = encryptSecret(input.stateJson);
  const ciphertext = JSON.stringify(encrypted);
  const row = await prisma.browserProfile.upsert({
    where: { userId_host: { userId: input.userId, host: input.host } },
    create: {
      userId: input.userId,
      name: input.name,
      host: input.host,
      stateCiphertext: ciphertext,
    },
    update: { name: input.name, stateCiphertext: ciphertext },
  });
  return { id: row.id };
}

/** Returns decrypted storage state — controller-side use only, never logged. */
export async function loadBrowserProfileState(
  userId: string,
  host: string
): Promise<{ id: string; stateJson: string } | null> {
  const row = await prisma.browserProfile.findUnique({ where: { userId_host: { userId, host } } });
  if (!row) return null;
  const stateJson = decryptSecret(JSON.parse(row.stateCiphertext));
  await prisma.browserProfile
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { id: row.id, stateJson };
}

export async function listBrowserProfiles(userId: string) {
  const rows = await prisma.browserProfile.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, host: true, lastUsedAt: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    host: r.host,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    // Never expose ciphertext — only a masked shape indicator.
    state: maskSecret('stored'),
  }));
}
