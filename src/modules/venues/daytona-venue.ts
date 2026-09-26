import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Venue,
  VenueExecResult,
  VenueFileEntry,
  VenueScreenshot,
  BrowserActInput,
  BrowserActResult,
  DesktopActInput,
  DesktopActResult,
  DesktopStatus,
  VenueBootStage,
  VenueHealth,
} from './venue';

/**
 * Daytona-backed Venue. One instance wraps one Sandbox.
 *
 * Two surfaces, both remote (the app server never runs a browser nor a shell):
 *   - BROWSER: `browser-controller.mjs` (Playwright) runs inside the sandbox on
 *     0.0.0.0:3100 and is reached through Daytona's short-lived signed preview
 *     URL with a per-session token.
 *   - DESKTOP: Daytona ComputerUse (Xvfb + xfce + x11vnc + noVNC) driven with
 *     the SDK's mouse/keyboard/screenshot/accessibility APIs.
 *
 * File transfer NEVER goes through `sandbox.fs.uploadFile/downloadFile`: those
 * load `form-data`/`busboy` with a runtime require that the Next standalone
 * trace does not ship ("Module form-data is not available in the node
 * runtime"), which broke every provisioning in production. We use the
 * sandbox's pre-signed file URLs with native fetch/FormData, and fall back to
 * base64 over `executeCommand`.
 *
 * Reliability rules (learned the hard way — every one of these produced a
 * "502 proxy upstream (DAYTONA_DAEMON)" that looked like a dead browser):
 *   - Only ONE controller start per sandbox at a time, process-wide.
 *   - A cooldown after a failed start (provisioning takes minutes).
 *   - The controller runs as an async Daytona process-session command;
 *     `nohup … &` inside executeCommand is the fallback.
 *   - Failures carry the real reason (controller log + provision output).
 *   - A controller from an older deploy (different protocol version) is
 *     replaced instead of being trusted.
 */

const CONTROLLER_REMOTE_DIR = '/tmp/unik';
const CONTROLLER_REMOTE_PATH = `${CONTROLLER_REMOTE_DIR}/browser-controller.mjs`;
const PROVISION_REMOTE_PATH = `${CONTROLLER_REMOTE_DIR}/provision.sh`;
const CONTROLLER_LOG_PATH = `${CONTROLLER_REMOTE_DIR}/controller.log`;
const CONTROLLER_SESSION = 'unik-browser';
const CONTROLLER_PORT = 3100;
/** Must match VERSION in browser-controller.mjs — older controllers are replaced. */
const CONTROLLER_VERSION = 2;
const DESKTOP_VNC_PORT = 6080;
const ACT_TIMEOUT_MS = 75_000;
const HEALTH_WAIT_MS = 60_000;
/** After a start attempt that did not reach health, wait this long before another. */
const START_COOLDOWN_MS = 45_000;
const DESKTOP_COOLDOWN_MS = 60_000;
/** Signed preview URLs are requested for 300 s; reuse them well inside that window. */
const PREVIEW_URL_TTL_MS = 200_000;
/** Base64 chunk per executeCommand (Linux caps one argument at 128 KiB). */
const EXEC_B64_CHUNK = 60_000;

type DaytonaClient = import('@daytonaio/sdk').Daytona;
type Sandbox = import('@daytonaio/sdk').Sandbox;

export interface DaytonaVenueConfig {
  apiKey: string;
  apiUrl?: string;
  /** Snapshot/image with node + playwright-core + chromium baked in. */
  image?: string;
  target?: string;
  autoStopMinutes?: number;
  /** Sandboxed domain allowlist (network-layer) — mirrors webDomainAllowlist. */
  domainAllowList?: string[];
}

/** Label that marks sandboxes created by this deployment (never touch others). */
export const VENUE_ENV_LABEL = 'unik-env';
export function venueEnvName(): string {
  return (
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.UNIK_ENV ||
    process.env.NODE_ENV ||
    'default'
  ).slice(0, 40);
}

/** One of OUR sandboxes as the provider reports it. */
export interface OwnSandbox {
  id: string;
  state: string;
  sessionId: string;
  env: string | null;
  /** Last update/creation (ms epoch) — used to age orphans. */
  touchedAt: number;
}

export interface AttachOptions {
  /**
   * false → never block on (re)provisioning from this call path (the live
   * poll and the panel's power button must answer fast). A background heal is
   * still kicked off through the lock.
   */
  heal?: boolean;
  /**
   * Start the sandbox when Daytona auto-stopped it. Defaults to `heal !== false`:
   * a passive poll never wakes (and bills) a paused computer.
   */
  wake?: boolean;
}

/**
 * Asset resolution — `__dirname` inside a bundled server chunk points at
 * `.next/server/chunks/` where our .mjs/.sh files do NOT exist (nft only
 * references the originals). The Dockerfile copies the assets folder next to
 * server.js, and under `next start` `src/` stays on disk.
 */
function readAsset(name: string): string {
  const candidates = [
    path.join(__dirname, 'assets', name),
    path.join(process.cwd(), 'src', 'modules', 'venues', 'assets', name),
    path.join(process.cwd(), 'modules', 'venues', 'assets', name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`Asset del venue no encontrado: ${name} (buscado en ${candidates.join(', ')})`);
}

let controllerScriptCache: string | null = null;
function controllerScript(): string {
  if (controllerScriptCache) return controllerScriptCache;
  controllerScriptCache = readAsset('browser-controller.mjs');
  return controllerScriptCache;
}

let provisionScriptCache: string | null = null;
function provisionScript(): string {
  if (provisionScriptCache) return provisionScriptCache;
  provisionScriptCache = readAsset('provision.sh');
  return provisionScriptCache;
}

/** Shell single-quote (paths, tokens — never trust them). */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface StartState {
  inFlight: Promise<boolean> | null;
  lastAttemptAt: number;
  lastOk: boolean;
  lastDiag: string;
  chromePath: string;
  stage: VenueBootStage;
  desktop: {
    inFlight: Promise<DesktopStatus> | null;
    lastAttemptAt: number;
    running: boolean;
    reason?: string;
    size?: { width: number; height: number };
  };
}
/** Per-sandbox start coordination — instances are per call, the sandbox is not. */
const startStates = new Map<string, StartState>();
function startStateFor(sandboxId: string): StartState {
  let s = startStates.get(sandboxId);
  if (!s) {
    s = {
      inFlight: null,
      lastAttemptAt: 0,
      lastOk: false,
      lastDiag: '',
      chromePath: '/usr/bin/chromium',
      stage: 'starting',
      desktop: { inFlight: null, lastAttemptAt: 0, running: false },
    };
    startStates.set(sandboxId, s);
    if (startStates.size > 200) {
      for (const [k, v] of startStates) {
        if (Date.now() - v.lastAttemptAt > 60 * 60_000) startStates.delete(k);
      }
    }
  }
  return s;
}

const previewUrlCache = new Map<string, { url: string; at: number }>();

export class DaytonaVenue implements Venue {
  private constructor(
    public readonly id: string,
    private sandbox: Sandbox,
    private client: DaytonaClient,
    private controllerToken: string
  ) {
    this.externalId = sandbox.id;
    this.kind = 'daytona';
  }

  readonly externalId: string;
  readonly kind: string;

  private get startState(): StartState {
    return startStateFor(this.sandbox.id);
  }

  /** Last provisioning/health diagnostics — surfaced in errors so the model
   *  and the panel can say WHY instead of a generic "VM error". */
  get lastDiag(): string {
    return this.startState.lastDiag;
  }

  private static async clientFor(cfg: DaytonaVenueConfig): Promise<DaytonaClient> {
    const { Daytona } = await import('@daytonaio/sdk');
    return new Daytona({
      apiKey: cfg.apiKey,
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
      ...(cfg.target ? { target: cfg.target } : {}),
    });
  }

  /**
   * Create a fresh sandbox for a DB session row. The browser stack is started
   * in the background (`warm`) or awaited — the panel's power button must not
   * hold an HTTP request for the minutes a first provisioning can take.
   */
  static async create(
    sessionId: string,
    cfg: DaytonaVenueConfig,
    opts: {
      warm?: 'await' | 'background';
      /**
       * Called as soon as the sandbox exists (before the browser stack is
       * prepared) so the caller persists its id: a failure later never leaves
       * an orphan sandbox eating the org's disk quota.
       */
      onCreated?: (externalId: string, controllerToken: string) => Promise<void>;
    } = {}
  ): Promise<DaytonaVenue> {
    const client = await DaytonaVenue.clientFor(cfg);
    const controllerToken =
      crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

    const baseParams = {
      envVars: {
        UNIK_BROWSER_TOKEN: controllerToken,
        // Keep secrets OUT of env — credentials go through act payloads only.
      },
      labels: { 'unik-session': sessionId, [VENUE_ENV_LABEL]: venueEnvName() },
      autoStopInterval: cfg.autoStopMinutes ?? 15,
      // A stopped sandbox still counts against the org's DISK quota (30 GiB on
      // the base tier). Archiving moves its filesystem to object storage and
      // frees that disk while keeping the user's files for the next session.
      autoArchiveInterval: 30,
      autoDeleteInterval: 60 * 24 * 3, // 3 days after stop
      public: false,
      // Network-layer egress control (unbypassable from inside): when the
      // admin configured a web allowlist, the sandbox can only reach those.
      ...(cfg.domainAllowList?.length ? { domainAllowList: cfg.domainAllowList.join(',') } : {}),
    };

    // The configured snapshot may not exist in this Daytona account (it is a
    // custom image). Fall back to the provider's default image — the browser
    // stack is provisioned inside the sandbox anyway.
    let sandbox: Sandbox;
    try {
      sandbox = await client.create(
        { ...baseParams, snapshot: cfg.image || undefined },
        { timeout: 180 }
      );
    } catch (err) {
      if (!cfg.image) throw err;
      sandbox = await client.create(baseParams, { timeout: 180 });
    }

    // `create` can return while the sandbox is still 'creating'/'starting' —
    // fs/process calls fail until it is 'started'.
    if (sandbox.state !== 'started') {
      try {
        await sandbox.start(60);
      } catch (err) {
        console.error('[venue] sandbox did not reach started state:', err);
        await sandbox.delete(60).catch(() => undefined); // no orphan billing
        throw err;
      }
    }

    if (opts.onCreated) {
      await opts.onCreated(sandbox.id, controllerToken).catch((err) => {
        console.error('[venue] could not persist the new sandbox id:', err);
      });
    }

    const venue = new DaytonaVenue(sessionId, sandbox, client, controllerToken);
    venue.startState.stage = 'uploading';
    if (opts.warm === 'background') {
      void venue.ensureController().catch(() => undefined);
    } else {
      await venue.ensureController();
    }
    return venue;
  }

  /**
   * Our sandboxes in the provider (label `unik-session`). Sandboxes of other
   * tools in the same Daytona org are never listed, so never touched.
   */
  static async listOwn(cfg: DaytonaVenueConfig, max = 400): Promise<OwnSandbox[]> {
    const client = await DaytonaVenue.clientFor(cfg);
    const out: OwnSandbox[] = [];
    let seen = 0;
    for await (const sb of client.list({ limit: 100 })) {
      if (++seen > max) break;
      const labels = (sb.labels ?? {}) as Record<string, string>;
      const sessionId = labels['unik-session'];
      if (!sessionId) continue;
      out.push({
        id: sb.id,
        state: String(sb.state ?? ''),
        sessionId,
        env: labels[VENUE_ENV_LABEL] ?? null,
        touchedAt: Date.parse(sb.updatedAt ?? sb.createdAt ?? '') || 0,
      });
    }
    return out;
  }

  /**
   * Frees the disk a sandbox holds: `archive` keeps its files (stop first),
   * `delete` removes it. Best-effort — returns whether it worked.
   */
  static async dispose(
    cfg: DaytonaVenueConfig,
    id: string,
    mode: 'archive' | 'delete'
  ): Promise<boolean> {
    const client = await DaytonaVenue.clientFor(cfg);
    try {
      const sb = await client.get(id);
      previewUrlCache.delete(id);
      startStates.delete(id);
      if (mode === 'delete') {
        await sb.delete(60);
        return true;
      }
      if (sb.state === 'archived') return true;
      if (sb.state === 'started') await sb.stop(90);
      await sb.archive();
      return true;
    } catch (err) {
      console.warn(
        `[venue] could not ${mode} sandbox ${id}:`,
        err instanceof Error ? err.message : err
      );
      return false;
    }
  }

  /** Reattach to an existing sandbox (session resumed after restart/idle). */
  static async attach(
    sessionId: string,
    externalId: string,
    cfg: DaytonaVenueConfig,
    controllerToken: string,
    opts: AttachOptions = {}
  ): Promise<DaytonaVenue> {
    const client = await DaytonaVenue.clientFor(cfg);
    const sandbox = await client.get(externalId);
    const wake = opts.wake ?? opts.heal !== false;
    if (sandbox.state !== 'started') {
      if (!wake) {
        // Passive poll: never wake a stopped sandbox (that would bill minutes).
        const venue = new DaytonaVenue(sessionId, sandbox, client, controllerToken);
        venue.startState.stage = 'starting';
        return venue;
      }
      // An archived sandbox is restored from object storage first — slower.
      await sandbox.start(sandbox.state === 'archived' ? 300 : 120);
      previewUrlCache.delete(externalId);
    }
    const venue = new DaytonaVenue(sessionId, sandbox, client, controllerToken);
    // Fast path: the controller may still be alive — re-running the full
    // provision+respawn on every call is expensive churn.
    if (await venue.controllerHealthy()) return venue;
    if (opts.heal === false) {
      // Poll path: heal in the background (serialized + cooled down), never block.
      void venue.ensureController().catch(() => undefined);
      return venue;
    }
    await venue.ensureController().catch(() => undefined);
    return venue;
  }

  get sandboxState(): string {
    return String(this.sandbox.state ?? 'unknown');
  }

  /** Cheap probe — is the in-sandbox controller (current protocol) serving /health? */
  async controllerHealthy(): Promise<boolean> {
    if (this.sandbox.state && this.sandbox.state !== 'started') return false;
    try {
      const res = await this.controllerFetch('/health', { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as { version?: number } | null;
      if (body?.version !== CONTROLLER_VERSION) {
        this.startState.lastDiag = 'controlador de una versión anterior — se reemplaza';
        return false;
      }
      this.startState.lastOk = true;
      this.startState.stage = 'ready';
      return true;
    } catch {
      return false;
    }
  }

  async ensureBrowser(): Promise<boolean> {
    if (await this.controllerHealthy()) return true;
    return this.ensureController();
  }

  /**
   * Bring the controller up — exactly one attempt at a time per sandbox, and
   * never more often than START_COOLDOWN_MS after a failed one. Concurrent
   * callers await the same attempt instead of racing it.
   */
  async ensureController(): Promise<boolean> {
    const st = this.startState;
    if (st.inFlight) return st.inFlight;
    if (!st.lastOk && st.lastAttemptAt > 0 && Date.now() - st.lastAttemptAt < START_COOLDOWN_MS) {
      return false; // a start just failed — let the sandbox breathe
    }
    st.lastAttemptAt = Date.now();
    st.inFlight = this.startController()
      .then((ok) => {
        st.lastOk = ok;
        st.stage = ok ? 'ready' : 'failed';
        return ok;
      })
      .catch((err) => {
        st.lastOk = false;
        st.stage = 'failed';
        st.lastDiag = `startController lanzó excepción: ${errText(err)}`;
        return false;
      })
      .finally(() => {
        st.inFlight = null;
      });
    return st.inFlight;
  }

  private async startController(): Promise<boolean> {
    const st = this.startState;
    st.stage = 'uploading';
    try {
      await this.putFile(PROVISION_REMOTE_PATH, Buffer.from(provisionScript(), 'utf8'));
      await this.putFile(CONTROLLER_REMOTE_PATH, Buffer.from(controllerScript(), 'utf8'));
    } catch (err) {
      // The toolbox can be briefly unavailable right after 'started'.
      await new Promise((r) => setTimeout(r, 2_500));
      try {
        await this.putFile(PROVISION_REMOTE_PATH, Buffer.from(provisionScript(), 'utf8'));
        await this.putFile(CONTROLLER_REMOTE_PATH, Buffer.from(controllerScript(), 'utf8'));
      } catch (err2) {
        st.lastDiag = `no se pudo copiar el controlador a la computadora virtual: ${errText(err2)} (primer intento: ${errText(err)})`;
        console.error('[venue] controller upload failed:', err2);
        return false;
      }
    }

    // Provision the browser stack (node, playwright-core + chromium). Stock
    // sandbox images may lack them; without this the controller can't even
    // import. Bounded and best-effort — non-browser tools don't need it.
    st.stage = 'provisioning';
    let provTail = '';
    try {
      const prov = await this.sandbox.process.executeCommand(
        `bash ${PROVISION_REMOTE_PATH}`,
        CONTROLLER_REMOTE_DIR,
        {},
        280
      );
      provTail = (prov.result ?? '').slice(-800);
      const m = /UNIK_CHROME_PATH=(\S+)/.exec(prov.result ?? '');
      if (m?.[1]) st.chromePath = m[1];
    } catch (e) {
      provTail = `provision lanzó excepción: ${errText(e)}`;
    }
    st.lastDiag = provTail;
    const provFail = /UNIK_PROV_FAIL=([^\n]+)/.exec(provTail)?.[1];
    if (provFail) {
      st.lastDiag = `provisioning falló (${provFail.trim()}): ${provTail.slice(-400)}`;
      console.error('[venue] provisioning failed:', st.lastDiag);
      return false;
    }

    st.stage = 'starting';
    if (!(await this.spawnController())) return false;

    // Wait for health through the signed preview URL; read the controller log
    // early so a crash-on-boot (missing module, EADDRINUSE) fails fast with
    // the real reason instead of a 60 s silence.
    const deadline = Date.now() + HEALTH_WAIT_MS;
    let nextLogCheck = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if (await this.controllerHealthy()) return true;
      if (Date.now() >= nextLogCheck) {
        nextLogCheck = Date.now() + 12_000;
        const log = await this.controllerLogTail();
        if (
          /Error|error:|Cannot find|EADDRINUSE|not found|ENOENT/.test(log) &&
          !/listening on/.test(log)
        ) {
          st.lastDiag = `el controlador no arrancó: ${log.slice(-400)} | prov: ${provTail.slice(-200)}`;
          console.error('[venue] browser controller crashed on boot:', st.lastDiag);
          return false;
        }
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    const diag = await this.controllerLogTail();
    st.lastDiag = `sin /health tras ${HEALTH_WAIT_MS / 1000}s: ${diag.slice(-400)} | prov: ${provTail.slice(-300)}`;
    console.error('[venue] browser controller did not reach health:', st.lastDiag);
    return false;
  }

  /**
   * Launch the controller detached. Preferred: an async command inside a
   * Daytona process session (kept alive by the daemon). Fallback: nohup.
   */
  private async spawnController(): Promise<boolean> {
    const st = this.startState;
    const env = `UNIK_BROWSER_TOKEN=${shq(this.controllerToken)} UNIK_CHROME_PATH=${shq(st.chromePath)}`;
    // TERM first (the controller exits cleanly), KILL whatever survived — a
    // lingering old controller holds :3100 and the new one dies EADDRINUSE.
    const kill = `pkill -f browser-controller.mjs 2>/dev/null; sleep 1; pkill -9 -f browser-controller.mjs 2>/dev/null; sleep 0.3;`;
    try {
      await this.sandbox.process.deleteSession(CONTROLLER_SESSION).catch(() => undefined);
      await this.sandbox.process.createSession(CONTROLLER_SESSION);
      await this.sandbox.process.executeSessionCommand(
        CONTROLLER_SESSION,
        { command: `${kill} cd ${CONTROLLER_REMOTE_DIR}`, runAsync: false },
        15
      );
      await this.sandbox.process.executeSessionCommand(
        CONTROLLER_SESSION,
        {
          command: `cd ${CONTROLLER_REMOTE_DIR} && ${env} node browser-controller.mjs > ${CONTROLLER_LOG_PATH} 2>&1`,
          runAsync: true,
        },
        15
      );
      return true;
    } catch (err) {
      console.warn('[venue] session spawn failed, falling back to nohup:', errText(err));
    }
    try {
      await this.sandbox.process.executeCommand(
        `${kill} cd ${CONTROLLER_REMOTE_DIR} && ${env} nohup node browser-controller.mjs > ${CONTROLLER_LOG_PATH} 2>&1 &`,
        CONTROLLER_REMOTE_DIR,
        {},
        10
      );
      return true;
    } catch (err) {
      st.lastDiag = `spawn controller falló: ${errText(err)}`;
      console.error('[venue] controller spawn failed:', err);
      return false;
    }
  }

  private async controllerLogTail(lines = 25): Promise<string> {
    try {
      const res = await this.sandbox.process.executeCommand(
        `tail -${lines} ${CONTROLLER_LOG_PATH} 2>/dev/null; echo "---"; node --version 2>&1 | head -1`,
        CONTROLLER_REMOTE_DIR,
        {},
        15
      );
      return (res.result ?? '').slice(-1200);
    } catch {
      return '';
    }
  }

  async health(): Promise<VenueHealth> {
    const st = this.startState;
    if (this.sandbox.state && this.sandbox.state !== 'started') {
      return { ok: false, stage: 'starting', reason: `la computadora está ${this.sandbox.state}` };
    }
    if (await this.controllerHealthy()) return { ok: true, stage: 'ready' };
    if (st.inFlight) return { ok: false, stage: st.stage, reason: st.lastDiag || undefined };
    return {
      ok: false,
      stage: st.lastAttemptAt > 0 && !st.lastOk ? 'failed' : 'starting',
      reason: st.lastDiag || undefined,
    };
  }

  /** Human-readable reason the browser is not answering — for the model and the panel. */
  async diagnose(): Promise<string> {
    const log = await this.controllerLogTail(12);
    const parts = [this.lastDiag, log ? `log: ${log}` : ''].filter(Boolean);
    return parts.join(' | ').replace(/\s+/g, ' ').slice(0, 600);
  }

  // -------------------------------------------------------------------------
  // Files — signed URLs (native fetch) with base64-over-exec fallback.
  // -------------------------------------------------------------------------

  private async execRaw(
    command: string,
    timeoutSec = 60
  ): Promise<{ exitCode: number; out: string }> {
    const res = await this.sandbox.process.executeCommand(
      command,
      undefined,
      undefined,
      timeoutSec
    );
    return { exitCode: res.exitCode ?? 0, out: res.result ?? '' };
  }

  private async putFile(filePath: string, buf: Buffer): Promise<void> {
    const dir = path.posix.dirname(filePath);
    await this.execRaw(`mkdir -p ${shq(dir)}`, 20).catch(() => undefined);
    try {
      const url = await this.sandbox.uploadUrl(filePath, 300);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)]), path.posix.basename(filePath));
      const res = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok)
        throw new Error(`upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    } catch (err) {
      console.warn('[venue] signed upload failed, using exec fallback:', errText(err));
    }
    await this.putFileViaExec(filePath, buf);
  }

  private async putFileViaExec(filePath: string, buf: Buffer): Promise<void> {
    const b64 = buf.toString('base64');
    const tmp = `${filePath}.unik-b64`;
    await this.execRaw(`: > ${shq(tmp)}`, 20);
    for (let i = 0; i < b64.length; i += EXEC_B64_CHUNK) {
      // The base64 alphabet has no quotes — single-quoting is safe.
      const part = b64.slice(i, i + EXEC_B64_CHUNK);
      const r = await this.execRaw(`printf '%s' '${part}' >> ${shq(tmp)}`, 60);
      if (r.exitCode !== 0) throw new Error(`escritura por partes falló: ${r.out.slice(0, 200)}`);
    }
    const done = await this.execRaw(
      `base64 -d ${shq(tmp)} > ${shq(filePath)} && rm -f ${shq(tmp)} && echo UNIK_WRITE_OK`,
      60
    );
    if (!done.out.includes('UNIK_WRITE_OK')) {
      throw new Error(`no se pudo escribir ${filePath}: ${done.out.slice(0, 200)}`);
    }
  }

  private async getFile(filePath: string, maxBytes: number): Promise<Buffer> {
    try {
      const url = await this.sandbox.downloadUrl(filePath, 300);
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab).subarray(0, maxBytes);
    } catch (err) {
      console.warn('[venue] signed download failed, using exec fallback:', errText(err));
    }
    const r = await this.execRaw(
      `head -c ${Math.floor(maxBytes)} ${shq(filePath)} | base64 -w0`,
      90
    );
    if (r.exitCode !== 0) throw new Error(`no se pudo leer ${filePath}: ${r.out.slice(0, 200)}`);
    return Buffer.from(r.out.trim(), 'base64');
  }

  async exec(
    command: string,
    opts: { cwd?: string; timeoutSec?: number; env?: Record<string, string> } = {}
  ): Promise<VenueExecResult> {
    const res = await this.sandbox.process.executeCommand(
      command,
      opts.cwd,
      opts.env,
      Math.min(Math.max(opts.timeoutSec ?? 60, 1), 300)
    );
    return { exitCode: res.exitCode ?? 0, stdout: (res.result ?? '').slice(0, 64_000) };
  }

  async readFile(filePath: string, maxBytes = 200_000): Promise<string> {
    return (await this.getFile(filePath, maxBytes)).toString('utf8');
  }

  async readFileBuffer(filePath: string, maxBytes = 20_000_000): Promise<Buffer> {
    return this.getFile(filePath, maxBytes);
  }

  async writeFile(filePath: string, content: string | Buffer): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (buf.byteLength > 10_000_000) {
      throw new Error('Archivo demasiado grande para la computadora virtual (máx 10 MB)');
    }
    await this.putFile(filePath, buf);
  }

  async listFiles(dirPath: string): Promise<VenueFileEntry[]> {
    try {
      const files = await this.sandbox.fs.listFiles(dirPath);
      return files.slice(0, 500).map((f) => ({
        name: f.name,
        path: `${dirPath.replace(/\/$/, '')}/${f.name}`,
        isDir: Boolean(f.isDir),
        size: f.size,
        modifiedAt: f.modTime,
      }));
    } catch (err) {
      // Toolbox listing unavailable — plain `ls` works on every image.
      const r = await this.execRaw(
        `cd ${shq(dirPath)} && for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] || [ ! -e "$f" ] && continue; if [ -d "$f" ]; then echo "d|$f|0"; else echo "f|$f|$(stat -c %s "$f" 2>/dev/null || echo 0)"; fi; done`,
        30
      );
      if (r.exitCode !== 0) throw err;
      return r.out
        .split('\n')
        .filter(Boolean)
        .slice(0, 500)
        .map((line) => {
          const [kind, name, size] = line.split('|');
          return {
            name,
            path: `${dirPath.replace(/\/$/, '')}/${name}`,
            isDir: kind === 'd',
            size: Number(size) || undefined,
          };
        });
    }
  }

  // -------------------------------------------------------------------------
  // Browser (controller)
  // -------------------------------------------------------------------------

  /** Fresh signed preview URL (they expire) for the controller port, cached briefly. */
  private async controllerBase(): Promise<string> {
    const cached = previewUrlCache.get(this.sandbox.id);
    if (cached && Date.now() - cached.at < PREVIEW_URL_TTL_MS) return cached.url;
    const signed = await this.sandbox.getSignedPreviewUrl(CONTROLLER_PORT, 300);
    previewUrlCache.set(this.sandbox.id, { url: signed.url, at: Date.now() });
    return signed.url;
  }

  /** Signed URLs may carry a query string — append the path to the pathname, never to the raw string. */
  private async controllerUrl(pathname: string): Promise<string> {
    const base = await this.controllerBase();
    try {
      const u = new URL(base);
      u.pathname = `${u.pathname.replace(/\/$/, '')}${pathname}`;
      return u.toString();
    } catch {
      return `${base.replace(/\/$/, '')}${pathname}`;
    }
  }

  private async controllerFetch(pathname: string, init?: RequestInit): Promise<Response> {
    const url = await this.controllerUrl(pathname);
    const res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-unik-token': this.controllerToken,
        // Daytona's preview proxy shows an HTML interstitial to browsers; this
        // is a server-to-server call.
        'X-Daytona-Skip-Preview-Warning': 'true',
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(ACT_TIMEOUT_MS),
    });
    // 401/403 from the proxy means the signed URL expired or was rotated.
    if (res.status === 401 || res.status === 403) previewUrlCache.delete(this.sandbox.id);
    return res;
  }

  async screenshot(): Promise<VenueScreenshot> {
    // The browser page first (what the agent is working on), desktop second.
    try {
      const pageShot = await this.browserAct({ action: 'screenshot' });
      if (pageShot.ok && pageShot.screenshotBase64) {
        return { imageBase64: pageShot.screenshotBase64, mimeType: 'image/jpeg' };
      }
    } catch {
      // controller down — fall through to the desktop frame
    }
    const shot = await this.desktopAct({ action: 'screenshot' });
    return { imageBase64: shot.screenshotBase64 ?? '', mimeType: 'image/jpeg' };
  }

  private async postAct(input: BrowserActInput): Promise<Response> {
    return this.controllerFetch('/act', { method: 'POST', body: JSON.stringify(input) });
  }

  async browserAct(input: BrowserActInput): Promise<BrowserActResult> {
    let res: Response | null = null;
    let failure = '';
    try {
      res = await this.postAct(input);
      if (res.status >= 500 || res.status === 401) {
        failure = `controller ${res.status}`;
        res = null;
      }
    } catch (err) {
      failure = errText(err);
    }
    if (!res) {
      // One serialized heal (provision + respawn) then a single retry. Callers
      // racing here await the same attempt instead of killing each other's.
      const healed = await this.ensureController();
      if (healed) {
        try {
          const retry = await this.postAct(input);
          if (retry.status < 500) res = retry;
          else failure = `controller ${retry.status}`;
        } catch (err) {
          failure = errText(err);
        }
      }
    }
    if (!res) {
      const why = await this.diagnose();
      const cause = /^controller \d+/.test(failure)
        ? `El proxy de la computadora virtual no alcanza al navegador (${failure.replace('controller ', 'HTTP ')}).`
        : 'El navegador de la computadora virtual aún no responde (se está preparando o su arranque falló).';
      return {
        ok: false,
        error: `${cause}${why ? ` Detalle: ${why}` : ''} Reintenta en un momento; si persiste, apaga y vuelve a encender la computadora desde el panel.`,
      };
    }
    const data = (await res.json().catch(() => null)) as BrowserActResult | null;
    if (!data) {
      const why = await this.diagnose();
      return {
        ok: false,
        error: `El navegador respondió ${res.status} sin JSON.${why ? ` Detalle: ${why}` : ''}`,
      };
    }
    if (data.screenshotBase64 && data.screenshotBase64.length > 8_000_000) {
      data.screenshotBase64 = undefined;
      data.error = data.error ?? 'captura demasiado grande';
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // Desktop (Daytona ComputerUse: Xvfb + xfce + VNC)
  // -------------------------------------------------------------------------

  async desktopStatus(): Promise<DesktopStatus> {
    const d = this.startState.desktop;
    if (this.sandbox.state && this.sandbox.state !== 'started') {
      return { running: false, reason: `la computadora está ${this.sandbox.state}` };
    }
    try {
      const s = await this.sandbox.computerUse.getStatus();
      const running = String(s.status ?? '').toLowerCase() === 'active';
      d.running = running;
      return running ? { running } : { running, reason: d.reason };
    } catch (err) {
      return { running: false, reason: d.reason ?? errText(err) };
    }
  }

  /** Start the desktop once (serialized + cooldown), then wait until active. */
  async ensureDesktop(): Promise<DesktopStatus> {
    const d = this.startState.desktop;
    const current = await this.desktopStatus();
    if (current.running) return current;
    if (d.inFlight) return d.inFlight;
    if (d.lastAttemptAt > 0 && Date.now() - d.lastAttemptAt < DESKTOP_COOLDOWN_MS && d.reason) {
      return { running: false, reason: d.reason };
    }
    d.lastAttemptAt = Date.now();
    d.inFlight = (async (): Promise<DesktopStatus> => {
      try {
        await this.sandbox.computerUse.start();
      } catch (err) {
        d.reason = `no se pudo iniciar el escritorio (Xvfb/xfce/VNC): ${errText(err).slice(0, 300)}`;
        return { running: false, reason: d.reason };
      }
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const s = await this.desktopStatus();
        if (s.running) {
          d.reason = undefined;
          return s;
        }
        await new Promise((r) => setTimeout(r, 1_200));
      }
      d.reason = 'el escritorio no terminó de arrancar en 45 s';
      return { running: false, reason: d.reason };
    })().finally(() => {
      d.inFlight = null;
    });
    return d.inFlight;
  }

  private async desktopFrame(
    quality = 60
  ): Promise<{ b64: string; width?: number; height?: number }> {
    const cu = this.sandbox.computerUse;
    const shot = await cu.screenshot.takeCompressed({
      showCursor: true,
      format: 'jpeg',
      quality: Math.min(Math.max(quality, 20), 90),
    });
    const d = this.startState.desktop;
    if (!d.size) {
      try {
        const info = await cu.display.getInfo();
        const main = info.displays?.find((x) => x.isActive) ?? info.displays?.[0];
        if (main?.width && main?.height) d.size = { width: main.width, height: main.height };
      } catch {
        // size is a nicety for coordinate mapping; the client falls back to the image size
      }
    }
    return { b64: shot.screenshot ?? '', width: d.size?.width, height: d.size?.height };
  }

  async desktopAct(input: DesktopActInput): Promise<DesktopActResult> {
    const status = await this.ensureDesktop();
    if (!status.running) {
      return {
        ok: false,
        error: status.reason ?? 'El escritorio de la computadora virtual no está disponible.',
      };
    }
    const cu = this.sandbox.computerUse;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);
    const x = num(input.x);
    const y = num(input.y);
    const needXY = () => {
      if (Number.isNaN(x) || Number.isNaN(y))
        throw new Error('x e y requeridos (píxeles de la pantalla)');
    };
    try {
      switch (input.action) {
        case 'screenshot':
          break;
        case 'click':
          needXY();
          await cu.mouse.click(x, y, 'left', false);
          break;
        case 'doubleClick':
          needXY();
          await cu.mouse.click(x, y, 'left', true);
          break;
        case 'rightClick':
          needXY();
          await cu.mouse.click(x, y, 'right', false);
          break;
        case 'move':
          needXY();
          await cu.mouse.move(x, y);
          break;
        case 'drag': {
          needXY();
          const tx = num(input.toX);
          const ty = num(input.toY);
          if (Number.isNaN(tx) || Number.isNaN(ty)) throw new Error('toX y toY requeridos');
          await cu.mouse.drag(x, y, tx, ty);
          break;
        }
        case 'scroll':
          await cu.mouse.scroll(
            Number.isNaN(x) ? 640 : x,
            Number.isNaN(y) ? 400 : y,
            input.direction ?? 'down',
            Math.min(Math.max(input.amount ?? 3, 1), 20)
          );
          break;
        case 'type':
          if (!input.text) throw new Error('text requerido');
          await cu.keyboard.type(input.text.slice(0, 4000), 15);
          break;
        case 'key':
        case 'hotkey': {
          const k = (input.key ?? '').trim();
          if (!k) throw new Error('key requerido (p. ej. "enter", "ctrl+c")');
          if (input.action === 'hotkey' || k.includes('+')) await cu.keyboard.hotkey(k);
          else await cu.keyboard.press(k);
          break;
        }
        case 'openApp': {
          const cmd = (input.command ?? '').trim();
          if (!cmd) throw new Error('command requerido (p. ej. "xfce4-terminal")');
          await this.execRaw(`DISPLAY=:0 nohup sh -c ${shq(cmd)} > /tmp/unik-app.log 2>&1 &`, 15);
          await new Promise((r) => setTimeout(r, 1_800));
          break;
        }
        case 'windows': {
          const w = await cu.display.getWindows();
          return {
            ok: true,
            windows: (w.windows ?? []).slice(0, 40).map((win) => ({
              id: String(win.id ?? ''),
              title: String(win.title ?? ''),
              active: win.isActive,
            })),
          };
        }
        case 'find': {
          const found = await cu.accessibility.findNodes({
            role: input.role || undefined,
            name: input.name || undefined,
            nameMatch: input.name ? 'contains' : undefined,
            scope: 'all',
            limit: 30,
          });
          return {
            ok: true,
            nodes: (found.matches ?? []).map((n) => ({
              id: String(n.id ?? ''),
              role: String(n.role ?? ''),
              name: String(n.name ?? ''),
              bounds: n.bounds,
            })),
          };
        }
        case 'invoke':
          if (!input.nodeId) throw new Error('nodeId requerido (de find)');
          await cu.accessibility.invokeNode(input.nodeId);
          break;
        case 'setValue':
          if (!input.nodeId) throw new Error('nodeId requerido (de find)');
          await cu.accessibility.setNodeValue(input.nodeId, input.value ?? '');
          break;
        case 'wait':
          await new Promise((r) =>
            setTimeout(r, Math.min(Math.max(input.seconds ?? 1, 0.2), 10) * 1000)
          );
          break;
        default:
          return { ok: false, error: `Acción de escritorio desconocida: ${String(input.action)}` };
      }
      if (input.action !== 'screenshot') await new Promise((r) => setTimeout(r, 350));
      const frame = await this.desktopFrame(
        input.quality ?? (input.action === 'screenshot' ? 70 : 55)
      );
      return { ok: true, screenshotBase64: frame.b64, width: frame.width, height: frame.height };
    } catch (err) {
      return { ok: false, error: errText(err).slice(0, 400) };
    }
  }

  async desktopViewerUrl(): Promise<string | null> {
    const status = await this.desktopStatus();
    if (!status.running) return null;
    const signed = await this.sandbox.getSignedPreviewUrl(DESKTOP_VNC_PORT, 3600);
    try {
      const u = new URL(signed.url);
      u.pathname = `${u.pathname.replace(/\/$/, '')}/vnc.html`;
      u.searchParams.set('autoconnect', 'true');
      u.searchParams.set('resize', 'scale');
      u.searchParams.set('reconnect', 'true');
      return u.toString();
    } catch {
      return `${signed.url.replace(/\/$/, '')}/vnc.html?autoconnect=true&resize=scale&reconnect=true`;
    }
  }

  async previewUrl(port: number, ttlSeconds = 3600): Promise<string> {
    const p = Math.floor(port);
    if (!Number.isFinite(p) || p < 1024 || p > 65535 || p === CONTROLLER_PORT) {
      throw new Error('Puerto inválido (usa 1024–65535, distinto de 3100)');
    }
    const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), 24 * 3600);
    const signed = await this.sandbox.getSignedPreviewUrl(p, ttl);
    return signed.url;
  }

  async stop(): Promise<void> {
    previewUrlCache.delete(this.sandbox.id);
    startStates.delete(this.sandbox.id);
    await this.sandbox.stop(60).catch(() => undefined);
  }

  async destroy(): Promise<void> {
    previewUrlCache.delete(this.sandbox.id);
    startStates.delete(this.sandbox.id);
    await this.sandbox.delete(60).catch(() => undefined);
  }
}
