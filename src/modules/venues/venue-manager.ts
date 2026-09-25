import { prisma } from '@/lib/prisma';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { recordUsage } from '@/modules/extensions/usage-meter';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { encryptSecret, decryptSecret, isSecretsConfigured, maskSecret } from '@/modules/extensions/secrets';
import { DaytonaVenue, type DaytonaVenueConfig } from './daytona-venue';
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

/**
 * Browser tools ride on the venue: an explicit `browserEnabled` choice in Admin
 * wins, but installs that never touched the flag (it's absent from the stored
 * settings) get the browser whenever the venue itself is on — a venue without
 * a browser can't do "abre google".
 */
export async function isBrowserToolEnabled(): Promise<boolean> {
  if (!(await isVenueEnabled())) return false;
  const row = await prisma.aiConfig
    .findUnique({ where: { key: 'global' }, select: { settings: true } })
    .catch(() => null);
  const raw = row?.settings;
  const flag = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).browserEnabled : undefined;
  return typeof flag === 'boolean' ? flag : true;
}

function minutesBetween(a: Date, b: Date): number {
  return Math.max(1, Math.ceil((b.getTime() - a.getTime()) / 60_000));
}

/** Emit a live event for the future "pantalla del agente" feed (SSE). */
export async function emitVenueEvent(sessionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await publishRealtime(`venue:${sessionId}`, type, payload);
  } catch {
    // feed is best-effort; never block work on it
  }
}

async function billMinutes(sessionId: string, userId: string, minutes: number): Promise<void> {
  await prisma.venueSession.update({
    where: { id: sessionId },
    data: { billedMinutes: { increment: minutes } },
  }).catch(() => undefined);
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
export async function acquireVenue(input: { userId: string; purpose?: string }): Promise<Venue> {
  const cfg = await daytonaConfig();
  if (!cfg) {
    throw new VenueUnavailableError('La computadora virtual está desactivada o falta DAYTONA_API_KEY.');
  }
  const settings = await getAiSettings();

  // Reuse the user's most recent active session when the sandbox is still up.
  const existing = await prisma.venueSession.findFirst({
    where: { userId: input.userId, status: { in: ['active', 'idle'] } },
    orderBy: { lastUsedAt: 'desc' },
  });
  if (existing?.externalId) {
    try {
      const token = (existing.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
      const venue = await DaytonaVenue.attach(existing.id, existing.externalId, cfg, token);
      await prisma.venueSession.update({
        where: { id: existing.id },
        data: { status: 'active', lastUsedAt: new Date() },
      });
      return venue;
    } catch {
      // Sandbox is gone or broken — retire the row and fall through to create.
      await prisma.venueSession.update({
        where: { id: existing.id },
        data: { status: 'error', endedAt: new Date() },
      }).catch(() => undefined);
    }
  }

  const [liveCount, usedMinutes] = await Promise.all([
    prisma.venueSession.count({ where: { status: { in: ['active', 'idle'] } } }),
    dailyVenueMinutes(),
  ]);
  if (liveCount >= (settings.venueMaxConcurrent || 2)) {
    throw new VenueUnavailableError(`Límite de computadoras virtuales simultáneas alcanzado (${settings.venueMaxConcurrent}).`);
  }
  if (usedMinutes >= (settings.venueMaxMinutesPerDay || 60)) {
    throw new VenueUnavailableError(`Presupuesto diario de computadora virtual agotado (${settings.venueMaxMinutesPerDay} min).`);
  }

  const session = await prisma.venueSession.create({
    data: { userId: input.userId, kind: 'daytona', status: 'active', purpose: input.purpose ?? null },
  });
  try {
    const venue = await DaytonaVenue.create(session.id, cfg);
    // Persist sandbox id + controller token so we can reattach later.
    await prisma.venueSession.update({
      where: { id: session.id },
      data: {
        externalId: venue.externalId,
        metadata: { controllerToken: venueToken(venue) },
      },
    });
    await emitVenueEvent(session.id, 'session_started', { externalId: venue.externalId, purpose: input.purpose });
    return venue;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[venue] create failed:', err);
    await prisma.venueSession.update({
      where: { id: session.id },
      data: { status: 'error', endedAt: new Date(), metadata: { error: reason.slice(0, 300) } },
    });
    throw new VenueUnavailableError(`No se pudo crear la computadora virtual: ${reason}`);
  }
}

function venueToken(venue: Venue): string {
  return (venue as unknown as { controllerToken?: string }).controllerToken ?? '';
}

/** Reattach to a specific session (tool calls carry sessionId). */
export async function attachVenue(sessionId: string, userId: string): Promise<Venue> {
  const session = await prisma.venueSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    throw new VenueUnavailableError('Sesión de computadora virtual no encontrada.');
  }
  if (session.status !== 'active' && session.status !== 'idle') {
    throw new VenueUnavailableError('La sesión de computadora virtual ya terminó — pide una nueva con el venue.');
  }
  const cfg = await daytonaConfig();
  if (!cfg || !session.externalId) throw new VenueUnavailableError('Venue no disponible.');
  const token = (session.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
  const venue = await DaytonaVenue.attach(session.id, session.externalId, cfg, token);
  await prisma.venueSession.update({ where: { id: session.id }, data: { status: 'active', lastUsedAt: new Date() } });
  return venue;
}

/** Mark the session idle and stop the sandbox (bills elapsed minutes). */
export async function releaseVenue(sessionId: string): Promise<void> {
  const session = await prisma.venueSession.findUnique({ where: { id: sessionId } });
  if (!session || (session.status !== 'active' && session.status !== 'idle')) return;
  await billMinutes(session.id, session.userId, minutesBetween(session.lastUsedAt, new Date()));
  const cfg = await daytonaConfig();
  if (cfg && session.externalId) {
    try {
      const token = (session.metadata as { controllerToken?: string } | null)?.controllerToken ?? '';
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
    throw new VenueUnavailableError('El vault de secretos no está configurado (UNIK_SECRETS_MASTER_KEY).');
  }
  const encrypted = encryptSecret(input.stateJson);
  const ciphertext = JSON.stringify(encrypted);
  const row = await prisma.browserProfile.upsert({
    where: { userId_host: { userId: input.userId, host: input.host } },
    create: { userId: input.userId, name: input.name, host: input.host, stateCiphertext: ciphertext },
    update: { name: input.name, stateCiphertext: ciphertext },
  });
  return { id: row.id };
}

/** Returns decrypted storage state — controller-side use only, never logged. */
export async function loadBrowserProfileState(userId: string, host: string): Promise<{ id: string; stateJson: string } | null> {
  const row = await prisma.browserProfile.findUnique({ where: { userId_host: { userId, host } } });
  if (!row) return null;
  const stateJson = decryptSecret(JSON.parse(row.stateCiphertext));
  await prisma.browserProfile.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
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
