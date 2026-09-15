/**
 * Polite fetching rules of the Sourcing Lab (plan 6.1, `robots-check.ts`).
 *
 * - `robots.txt` is always respected (RFC 9309): groups by user agent, longest
 *   matching rule wins, `Allow` wins a tie, `*` and `$` patterns. A missing
 *   file (4xx) allows everything; an unreachable one (5xx, network) forbids
 *   everything until it can be read.
 * - At most one request every 2 seconds per host (or the `Crawl-delay` when it
 *   is longer), robots.txt included, coordinated between instances by the time
 *   of the last granted request of the host (the server wires the store to an
 *   atomic conditional update in `UsageMeter`): two requests are never closer
 *   than the interval, whatever instance or crawl delay asked for them.
 * - A CAPTCHA or bot challenge is never solved: the page is abandoned.
 *
 * The parsing and the decisions are pure; `RobotsGuard` receives the fetcher,
 * the slot store and the clock, so it is fully testable.
 */

export const SOURCING_USER_AGENT = 'UNIKSourcingBot/1.0 (+https://unik.mx/bot)';
export const SOURCING_AGENT_TOKEN = 'uniksourcingbot';
export const HOST_MIN_INTERVAL_MS = 2_000;
export const ROBOTS_CACHE_TTL_MS = 60 * 60_000;
export const MAX_CRAWL_DELAY_MS = 30_000;

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

/** Parses robots.txt into groups (consecutive user-agent lines share the next rules). */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    collectingAgents = false;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "allow everything" and adds no rule.
      if (!value) continue;
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

/** Group of the most specific agent token contained in `userAgent`; falls back to `*`. */
export function selectRobotsGroup(groups: readonly RobotsGroup[], userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | null = null;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*' || !agent) continue;
      if (ua.includes(agent) && (!best || agent.length > best.length)) best = { group, length: agent.length };
    }
  }
  if (best) {
    // Several groups may name the same agent: their rules combine.
    const agent = best.group.agents.find((a) => ua.includes(a) && a.length === best!.length)!;
    const same = groups.filter((g) => g.agents.includes(agent));
    return same.length === 1
      ? same[0]
      : {
          agents: [agent],
          rules: same.flatMap((g) => g.rules),
          crawlDelaySeconds: same.find((g) => g.crawlDelaySeconds !== null)?.crawlDelaySeconds ?? null,
        };
  }
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  if (wildcard.length === 0) return null;
  return {
    agents: ['*'],
    rules: wildcard.flatMap((g) => g.rules),
    crawlDelaySeconds: wildcard.find((g) => g.crawlDelaySeconds !== null)?.crawlDelaySeconds ?? null,
  };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Longest matching rule decides; `Allow` wins a tie; no matching rule allows. `/robots.txt` is always allowed. */
export function isPathAllowed(groups: readonly RobotsGroup[], userAgent: string, pathWithQuery: string): boolean {
  const path = pathWithQuery || '/';
  if (path === '/robots.txt') return true;
  const group = selectRobotsGroup(groups, userAgent);
  if (!group) return true;
  let winner: RobotsRule | null = null;
  let winnerLength = -1;
  const candidates = [path, decodePath(path)];
  for (const rule of group.rules) {
    const regex = patternToRegExp(rule.path);
    if (!candidates.some((candidate) => regex.test(candidate))) continue;
    const length = rule.path.length;
    if (length > winnerLength || (length === winnerLength && rule.allow && winner && !winner.allow)) {
      winner = rule;
      winnerLength = length;
    }
  }
  return winner ? winner.allow : true;
}

export type RobotsAvailability = 'parse' | 'allow_all' | 'disallow_all';

/** RFC 9309: 2xx parse, 4xx "unavailable" allows, 5xx/network "unreachable" disallows. */
export function robotsAvailabilityForStatus(status: number | null): RobotsAvailability {
  if (status === null || !Number.isFinite(status)) return 'disallow_all';
  if (status >= 200 && status < 300) return 'parse';
  if (status >= 400 && status < 500) return 'allow_all';
  return 'disallow_all';
}

const CAPTCHA_MARKERS = [
  /captcha/i,
  /g-recaptcha/i,
  /hcaptcha/i,
  /cf-challenge/i,
  /challenge-platform/i,
  /cf_chl_/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /verify you are (a )?human/i,
  /are you a robot/i,
  /verifica que eres humano/i,
  /no eres un robot/i,
  /px-captcha/i,
  /datadome/i,
];

/** A page that asks to prove being human: it is never solved, the fetch is abandoned. */
export function looksLikeCaptcha(status: number, body: string): boolean {
  const sample = String(body ?? '').slice(0, 200_000);
  const marked = CAPTCHA_MARKERS.some((marker) => marker.test(sample));
  if (status === 403 || status === 429 || status === 503) return marked || /cloudflare|access denied/i.test(sample);
  return marked && sample.length < 60_000;
}

/** Milliseconds until `intervalMs` have passed since the last granted request of a host (0 = now). */
export function turnWaitMs(lastMs: number | null, nowMs: number, intervalMs = HOST_MIN_INTERVAL_MS): number {
  if (lastMs === null || !Number.isFinite(lastMs)) return 0;
  return Math.max(0, Math.ceil(lastMs + intervalMs - nowMs));
}

/**
 * Next hop of a redirect of a catalog page, or null when it must not be
 * followed (no location, not https, host outside the allowlist). The caller
 * checks robots.txt and waits its turn again for the new URL.
 */
export function redirectTarget(current: string, location: string | null, isHostAllowed: (host: string) => boolean): string | null {
  if (!location) return null;
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  if (next.protocol !== 'https:') return null;
  if (!isHostAllowed(next.hostname.toLowerCase())) return null;
  return next.toString();
}

export interface HostTurn {
  granted: boolean;
  /** When not granted: how long until the host is free. */
  waitMs: number;
}

export interface HostSlotStore {
  /** Grants a request to `host` only when `intervalMs` passed since the last granted one (atomic across instances). */
  claimTurn(host: string, intervalMs: number, now: Date): Promise<HostTurn>;
}

export interface RobotsFetchResult {
  status: number | null;
  body: string;
}

export type RobotsFetcher = (url: string) => Promise<RobotsFetchResult>;

export interface RobotsGuardDeps {
  fetchRobots: RobotsFetcher;
  slots: HostSlotStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  cacheTtlMs?: number;
}

export interface RobotsDecision {
  allowed: boolean;
  reason: 'allowed' | 'robots_disallowed' | 'robots_unreachable' | 'invalid_url';
  crawlDelayMs: number;
}

interface CachedRobots {
  availability: RobotsAvailability;
  groups: RobotsGroup[];
  fetchedAt: number;
}

/** robots.txt cache + per-host throttle. One guard per process is enough. */
export class RobotsGuard {
  private readonly cache = new Map<string, CachedRobots>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private readonly ttl: number;

  constructor(private readonly deps: RobotsGuardDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = deps.userAgent ?? SOURCING_USER_AGENT;
    this.ttl = deps.cacheTtlMs ?? ROBOTS_CACHE_TTL_MS;
  }

  private async robotsFor(origin: string): Promise<CachedRobots> {
    const cached = this.cache.get(origin);
    const nowMs = this.now().getTime();
    if (cached && nowMs - cached.fetchedAt < this.ttl) return cached;
    // robots.txt is a request to the host too: it waits its turn (not cached when the host stays busy).
    if (!(await this.acquireSlot(new URL(origin).hostname))) {
      return { availability: 'disallow_all', groups: [], fetchedAt: nowMs };
    }
    let result: RobotsFetchResult;
    try {
      result = await this.deps.fetchRobots(`${origin}/robots.txt`);
    } catch {
      result = { status: null, body: '' };
    }
    const availability = robotsAvailabilityForStatus(result.status);
    const entry: CachedRobots = {
      availability,
      groups: availability === 'parse' ? parseRobotsTxt(result.body) : [],
      fetchedAt: nowMs,
    };
    this.cache.set(origin, entry);
    return entry;
  }

  async check(url: string): Promise<RobotsDecision> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'invalid_url', crawlDelayMs: HOST_MIN_INTERVAL_MS };
    }
    const robots = await this.robotsFor(parsed.origin);
    if (robots.availability === 'disallow_all') {
      return { allowed: false, reason: 'robots_unreachable', crawlDelayMs: HOST_MIN_INTERVAL_MS };
    }
    const group = selectRobotsGroup(robots.groups, this.userAgent);
    const crawlDelayMs = Math.min(
      MAX_CRAWL_DELAY_MS,
      Math.max(HOST_MIN_INTERVAL_MS, Math.round((group?.crawlDelaySeconds ?? 0) * 1000))
    );
    if (robots.availability === 'allow_all') return { allowed: true, reason: 'allowed', crawlDelayMs };
    const allowed = isPathAllowed(robots.groups, this.userAgent, `${parsed.pathname}${parsed.search}`);
    return { allowed, reason: allowed ? 'allowed' : 'robots_disallowed', crawlDelayMs };
  }

  /** Waits until this process is granted the next request to `host` (never more than `maxWaitMs`). */
  async acquireSlot(host: string, intervalMs = HOST_MIN_INTERVAL_MS, maxWaitMs = 20_000): Promise<boolean> {
    const started = this.now().getTime();
    for (;;) {
      const turn = await this.deps.slots.claimTurn(host.toLowerCase(), intervalMs, this.now());
      if (turn.granted) return true;
      const elapsed = this.now().getTime() - started;
      if (elapsed >= maxWaitMs) return false;
      await this.sleep(Math.max(50, Math.min(turn.waitMs, maxWaitMs - elapsed)));
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
