import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Venue,
  VenueExecResult,
  VenueFileEntry,
  VenueScreenshot,
  BrowserActInput,
  BrowserActResult,
} from './venue';

/**
 * Daytona-backed Venue. One instance wraps one Sandbox.
 *
 * The browser runs INSIDE the sandbox: we upload `browser-controller.mjs`,
 * start it on 0.0.0.0:3100 with a one-time token, and reach it through
 * Daytona's short-lived signed preview URL. Nothing on the app server
 * executes commands or drives a browser — everything is remote.
 *
 * Reliability rules (learned the hard way — every one of these produced a
 * "502 proxy upstream (DAYTONA_DAEMON)" that looked like a dead browser):
 *   - Only ONE startController per sandbox at a time, process-wide. Tool calls
 *     and the live-state poll used to race: each `pkill` killed the controller
 *     the other had just spawned, forever.
 *   - A cooldown after a failed start: retrying every 4 s re-runs a minutes-long
 *     provisioning and never lets the previous one finish.
 *   - The controller runs as an async Daytona process-session command, which
 *     is the documented way to keep a server alive; `nohup … &` inside
 *     executeCommand is the fallback.
 *   - Failures carry the real reason (controller.log tail + provision output)
 *     instead of the proxy's generic 502 body.
 */

const CONTROLLER_REMOTE_DIR = '/tmp/unik';
const CONTROLLER_REMOTE_PATH = `${CONTROLLER_REMOTE_DIR}/browser-controller.mjs`;
const PROVISION_REMOTE_PATH = `${CONTROLLER_REMOTE_DIR}/provision.sh`;
const CONTROLLER_LOG_PATH = `${CONTROLLER_REMOTE_DIR}/controller.log`;
const CONTROLLER_SESSION = 'unik-browser';
const CONTROLLER_PORT = 3100;
const ACT_TIMEOUT_MS = 75_000;
const HEALTH_WAIT_MS = 60_000;
/** After a start attempt that did not reach health, wait this long before another. */
const START_COOLDOWN_MS = 45_000;
/** Signed preview URLs are requested for 300 s; reuse them well inside that window. */
const PREVIEW_URL_TTL_MS = 200_000;

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

export interface AttachOptions {
  /**
   * false → never (re)provision from this call path (the live-state poll must
   * not block for minutes nor compete with the tool call that is already
   * healing). A background heal is still kicked off through the lock.
   */
  heal?: boolean;
}

/**
 * Asset resolution — `__dirname` inside a bundled server chunk points at
 * `.next/server/chunks/` where our .mjs/.sh files do NOT exist (nft only
 * references the originals). Under `next start` the repo root is the cwd and
 * `src/` stays on disk, so we try every candidate before giving up.
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

/** Shell single-quote (the token is hex and the chrome path is a plain path, but never trust it). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface StartState {
  inFlight: Promise<boolean> | null;
  lastAttemptAt: number;
  lastOk: boolean;
  lastDiag: string;
  chromePath: string;
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

  /** Last provisioning/health diagnostics — surfaced in browserAct errors so
   *  the model can report WHY instead of a generic "VM error". */
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
   * Create a fresh sandbox + controller for a DB session row.
   * `sessionId` is the VenueSession.id (used for labels/logging only).
   */
  static async create(sessionId: string, cfg: DaytonaVenueConfig): Promise<DaytonaVenue> {
    const client = await DaytonaVenue.clientFor(cfg);
    const controllerToken =
      crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

    const baseParams = {
      envVars: {
        UNIK_BROWSER_TOKEN: controllerToken,
        // Keep secrets OUT of env — credentials go through act payloads only.
      },
      labels: { 'unik-session': sessionId },
      autoStopInterval: cfg.autoStopMinutes ?? 15,
      autoDeleteInterval: 60 * 24, // hard ceiling: 24h
      public: false,
      // Network-layer egress control (unbypassable from inside): when the
      // admin configured a web allowlist, the sandbox can only reach those.
      ...(cfg.domainAllowList?.length ? { domainAllowList: cfg.domainAllowList.join(',') } : {}),
    };

    // The configured snapshot may not exist in this Daytona account (it is a
    // custom image). Fall back to the provider's default image — the browser
    // stack is provisioned inside the sandbox anyway (startController).
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
    // fs/process calls fail until it is 'started' (attach() already waits).
    if (sandbox.state !== 'started') {
      try {
        await sandbox.start(60);
      } catch (err) {
        console.error('[venue] sandbox did not reach started state:', err);
        await sandbox.delete(60).catch(() => undefined); // no orphan billing
        throw err;
      }
    }

    const venue = new DaytonaVenue(sessionId, sandbox, client, controllerToken);
    await venue.ensureController();
    return venue;
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
    if (sandbox.state !== 'started') {
      await sandbox.start(60);
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

  /** Cheap probe — is the in-sandbox controller already serving /health? */
  async controllerHealthy(): Promise<boolean> {
    try {
      const res = await this.controllerFetch('/health', { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        this.startState.lastOk = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Bring the controller up — exactly one attempt at a time per sandbox, and
   * never more often than START_COOLDOWN_MS after a failed one. Concurrent
   * callers await the same attempt instead of racing it.
   */
  async ensureController(): Promise<boolean> {
    const st = this.startState;
    if (st.inFlight) return st.inFlight;
    if (!st.lastOk && Date.now() - st.lastAttemptAt < START_COOLDOWN_MS && st.lastAttemptAt > 0) {
      return false; // a start just failed — let the sandbox breathe
    }
    st.lastAttemptAt = Date.now();
    st.inFlight = this.startController()
      .then((ok) => {
        st.lastOk = ok;
        return ok;
      })
      .catch((err) => {
        st.lastOk = false;
        st.lastDiag = `startController lanzó excepción: ${err instanceof Error ? err.message : err}`;
        return false;
      })
      .finally(() => {
        st.inFlight = null;
      });
    return st.inFlight;
  }

  private async startController(): Promise<boolean> {
    const st = this.startState;
    try {
      await this.sandbox.fs.createFolder(CONTROLLER_REMOTE_DIR, '755').catch(() => undefined);
      await this.sandbox.fs.uploadFile(
        Buffer.from(provisionScript(), 'utf8'),
        PROVISION_REMOTE_PATH
      );
      await this.sandbox.fs.uploadFile(
        Buffer.from(controllerScript(), 'utf8'),
        CONTROLLER_REMOTE_PATH
      );
    } catch {
      // fs goes through the toolbox proxy — it can be briefly unavailable
      // right after 'started'. Retry once before giving up.
      await new Promise((r) => setTimeout(r, 2_500));
      try {
        await this.sandbox.fs.uploadFile(
          Buffer.from(provisionScript(), 'utf8'),
          PROVISION_REMOTE_PATH
        );
        await this.sandbox.fs.uploadFile(
          Buffer.from(controllerScript(), 'utf8'),
          CONTROLLER_REMOTE_PATH
        );
      } catch (err2) {
        st.lastDiag = `upload controller falló: ${err2 instanceof Error ? err2.message : err2}`;
        console.error('[venue] controller upload failed:', err2);
        return false;
      }
    }

    // Provision the browser stack (node, playwright-core + chromium). Stock
    // sandbox images may lack them; without this the controller can't even
    // import. Bounded and best-effort — non-browser tools don't need it.
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
      provTail = `provision lanzó excepción: ${e instanceof Error ? e.message : e}`;
    }
    st.lastDiag = provTail;
    const provFail = /UNIK_PROV_FAIL=(\S+)/.exec(provTail)?.[1];
    if (provFail) {
      st.lastDiag = `provisioning falló (${provFail}): ${provTail.slice(-400)}`;
      console.error('[venue] provisioning failed:', st.lastDiag);
      return false;
    }

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
    // Not fatal — browser acts will retry lazily. But capture WHY now.
    const diag = await this.controllerLogTail();
    st.lastDiag = `sin /health tras ${HEALTH_WAIT_MS / 1000}s: ${diag.slice(-400)} | prov: ${provTail.slice(-300)}`;
    console.error('[venue] browser controller did not reach health:', st.lastDiag);
    return false;
  }

  /**
   * Launch the controller detached. Preferred: an async command inside a
   * Daytona process session (kept alive by the daemon — the documented way to
   * run a server). Fallback: nohup inside executeCommand.
   */
  private async spawnController(): Promise<boolean> {
    const st = this.startState;
    const env = `UNIK_BROWSER_TOKEN=${shq(this.controllerToken)} UNIK_CHROME_PATH=${shq(st.chromePath)}`;
    const kill = `pkill -f browser-controller.mjs 2>/dev/null; sleep 1;`;
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
      console.warn(
        '[venue] session spawn failed, falling back to nohup:',
        err instanceof Error ? err.message : err
      );
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
      st.lastDiag = `spawn controller falló: ${err instanceof Error ? err.message : err}`;
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

  async health(): Promise<{ ok: boolean; reason?: string }> {
    const ok = await this.controllerHealthy();
    return ok ? { ok } : { ok, reason: this.lastDiag || undefined };
  }

  /** Human-readable reason the browser is not answering — for the model and the panel. */
  async diagnose(): Promise<string> {
    const log = await this.controllerLogTail(12);
    const parts = [this.lastDiag, log ? `log: ${log}` : ''].filter(Boolean);
    return parts.join(' | ').replace(/\s+/g, ' ').slice(0, 600);
  }

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
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(ACT_TIMEOUT_MS),
    });
    // 401/403 from the proxy means the signed URL expired or was rotated.
    if (res.status === 401 || res.status === 403) previewUrlCache.delete(this.sandbox.id);
    return res;
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

  async readFile(path: string, maxBytes = 200_000): Promise<string> {
    const buf = await this.sandbox.fs.downloadFile(path);
    return buf.subarray(0, maxBytes).toString('utf8');
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (buf.byteLength > 2_000_000)
      throw new Error('Archivo demasiado grande para el venue (máx 2MB)');
    await this.sandbox.fs.uploadFile(buf, path);
  }

  async listFiles(path: string): Promise<VenueFileEntry[]> {
    const files = await this.sandbox.fs.listFiles(path);
    return files.slice(0, 500).map((f) => ({
      name: f.name,
      path: f.path ?? `${path.replace(/\/$/, '')}/${f.name}`,
      isDir: Boolean(f.isDir),
      size: f.size,
      modifiedAt: f.modifiedAt ?? f.modTime,
    }));
  }

  async screenshot(): Promise<VenueScreenshot> {
    // The meaningful "screen" is the browser page — the desktop screenshot only
    // works on desktop-enabled images; stock sandboxes are headless and return
    // a black/empty frame. Browser first, desktop as fallback.
    try {
      const pageShot = await this.browserAct({ action: 'screenshot' });
      if (pageShot.ok && pageShot.screenshotBase64) {
        return { imageBase64: pageShot.screenshotBase64, mimeType: 'image/jpeg' };
      }
    } catch {
      // controller down — fall through to the desktop frame
    }
    const shot = await this.sandbox.computerUse.screenshot.takeCompressed({
      showCursor: true,
      format: 'jpeg',
      quality: 70,
    });
    const b64 = shot.screenshot ?? '';
    return { imageBase64: b64, mimeType: 'image/jpeg' };
  }

  private async postAct(input: BrowserActInput): Promise<Response> {
    return this.controllerFetch('/act', { method: 'POST', body: JSON.stringify(input) });
  }

  async browserAct(input: BrowserActInput): Promise<BrowserActResult> {
    let res: Response | null = null;
    let failure = '';
    try {
      res = await this.postAct(input);
      if (res.status >= 500) {
        failure = `controller ${res.status}`;
        res = null;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
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
          failure = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (!res) {
      const why = await this.diagnose();
      const cause = /^controller \d+/.test(failure)
        ? `El proxy de la computadora virtual no alcanza al navegador (${failure.replace('controller ', 'HTTP ')}).`
        : 'El navegador de la computadora virtual aún no responde (aprovisionando o el controlador falló al arrancar).';
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
      data.error = 'screenshot demasiado grande';
    }
    return data;
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
