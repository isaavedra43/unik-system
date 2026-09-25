import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Venue, VenueExecResult, VenueFileEntry, VenueScreenshot,
  BrowserActInput, BrowserActResult,
} from './venue';

/**
 * Daytona-backed Venue. One instance wraps one Sandbox.
 *
 * The browser runs INSIDE the sandbox: we upload `browser-controller.mjs`,
 * start it on 127.0.0.1:3100 with a one-time token, and reach it through
 * Daytona's short-lived signed preview URL. Nothing on the app server
 * executes commands or drives a browser — everything is remote.
 */

const CONTROLLER_REMOTE_DIR = '/tmp/unik';
const CONTROLLER_REMOTE_PATH = `${CONTROLLER_REMOTE_DIR}/browser-controller.mjs`;
const PROVISION_REMOTE_PATH = `${CONTROLLER_REMOTE_DIR}/provision.sh`;
const CONTROLLER_PORT = 3100;
const ACT_TIMEOUT_MS = 75_000;

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

export class DaytonaVenue implements Venue {
  private constructor(
    public readonly id: string,
    private sandbox: Sandbox,
    private client: DaytonaClient,
    private controllerToken: string,
    private controllerBaseUrl: string | null
  ) {
    this.externalId = sandbox.id;
    this.kind = 'daytona';
  }

  readonly externalId: string;
  readonly kind: string;

  /**
   * Create a fresh sandbox + controller for a DB session row.
   * `sessionId` is the VenueSession.id (used for labels/logging only).
   */
  static async create(sessionId: string, cfg: DaytonaVenueConfig): Promise<DaytonaVenue> {
    const { Daytona } = await import('@daytonaio/sdk');
    const client = new Daytona({
      apiKey: cfg.apiKey,
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
      ...(cfg.target ? { target: cfg.target } : {}),
    });
    const controllerToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

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
    // Without this the very first uploadFile dies with a confusing
    // "VM can't start" error even when the Daytona API is healthy.
    if (sandbox.state !== 'started') {
      try {
        await sandbox.start(60);
      } catch (err) {
        console.error('[venue] sandbox did not reach started state:', err);
        await sandbox.delete(60).catch(() => undefined); // no orphan billing
        throw err;
      }
    }

    const venue = new DaytonaVenue(sessionId, sandbox, client, controllerToken, null);
    await venue.startController();
    return venue;
  }

  /** Reattach to an existing sandbox (session resumed after restart/idle). */
  static async attach(sessionId: string, externalId: string, cfg: DaytonaVenueConfig, controllerToken: string): Promise<DaytonaVenue> {
    const { Daytona } = await import('@daytonaio/sdk');
    const client = new Daytona({
      apiKey: cfg.apiKey,
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
      ...(cfg.target ? { target: cfg.target } : {}),
    });
    const sandbox = await client.get(externalId);
    if (sandbox.state !== 'started') {
      await sandbox.start(60);
    }
    const venue = new DaytonaVenue(sessionId, sandbox, client, controllerToken, null);
    // Fast path: the controller may still be alive — re-running the full
    // provision+respawn on every /venue/state poll is expensive churn, and a
    // second `node browser-controller.mjs` clobbers controller.log via EADDRINUSE.
    if (await venue.controllerHealthy()) return venue;
    await venue.startController().catch(() => null);
    return venue;
  }

  /** Cheap probe — is the in-sandbox controller already serving /health? */
  private async controllerHealthy(): Promise<boolean> {
    try {
      const base = await this.controllerUrl();
      const res = await this.controllerFetch(`${base}/health`, { signal: AbortSignal.timeout(8_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private chromePath = '/usr/bin/chromium';
  /** Last provisioning/health diagnostics — surfaced in browserAct errors so
   *  the model can report WHY instead of a generic "VM error". */
  private lastDiag = '';

  private async startController(): Promise<void> {
    try {
      await this.sandbox.fs.createFolder(CONTROLLER_REMOTE_DIR, '755').catch(() => undefined);
      await this.sandbox.fs.uploadFile(Buffer.from(provisionScript(), 'utf8'), PROVISION_REMOTE_PATH);
      await this.sandbox.fs.uploadFile(Buffer.from(controllerScript(), 'utf8'), CONTROLLER_REMOTE_PATH);
    } catch {
      // fs goes through the toolbox proxy — it can be briefly unavailable
      // right after 'started'. Retry once before giving up.
      await new Promise((r) => setTimeout(r, 2_500));
      try {
        await this.sandbox.fs.uploadFile(Buffer.from(provisionScript(), 'utf8'), PROVISION_REMOTE_PATH);
        await this.sandbox.fs.uploadFile(Buffer.from(controllerScript(), 'utf8'), CONTROLLER_REMOTE_PATH);
      } catch (err2) {
        this.lastDiag = `upload controller falló: ${err2 instanceof Error ? err2.message : err2}`;
        console.error('[venue] controller upload failed:', err2);
        return; // browserAct will surface lastDiag and retry lazily
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
      if (m?.[1]) this.chromePath = m[1];
    } catch (e) {
      provTail = `provision lanzó excepción: ${e instanceof Error ? e.message : e}`;
    }
    this.lastDiag = provTail;

    // Start detached so executeCommand returns immediately.
    try {
      await this.sandbox.process.executeCommand(
        `cd ${CONTROLLER_REMOTE_DIR} && nohup node browser-controller.mjs > controller.log 2>&1 &`,
        CONTROLLER_REMOTE_DIR,
        { UNIK_BROWSER_TOKEN: this.controllerToken, UNIK_CHROME_PATH: this.chromePath },
        10
      );
    } catch (err) {
      this.lastDiag = `spawn controller falló: ${err instanceof Error ? err.message : err} | prov: ${provTail.slice(-200)}`;
      console.error('[venue] controller spawn failed:', err);
      return;
    }
    // Wait for health through the signed preview URL.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const base = await this.controllerUrl();
        const res = await this.controllerFetch(`${base}/health`);
        if (res.ok) return;
      } catch {
        // controller still booting
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    // Not fatal — browser acts will retry lazily (attach re-runs this). But
    // capture WHY now: controller.log tail + provision output tell the real
    // story (missing node, apt denied, allowlist blocking npm, etc).
    try {
      const diag = await this.exec(
        `tail -20 ${CONTROLLER_REMOTE_DIR}/controller.log 2>/dev/null; echo "---"; node --version 2>&1; command -v chromium || echo no-chromium`,
        { timeoutSec: 15 }
      );
      this.lastDiag = `${diag.stdout.slice(0, 500)} | prov: ${provTail.slice(-300)}`;
      console.error('[venue] browser controller did not reach health:', this.lastDiag);
    } catch { /* diagnostics are best-effort */ }
  }

  /** Fresh signed preview URL (they expire) for the controller port. */
  private async controllerUrl(): Promise<string> {
    const signed = await this.sandbox.getSignedPreviewUrl(CONTROLLER_PORT, 300);
    return signed.url.replace(/\/$/, '');
  }

  private async controllerFetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-unik-token': this.controllerToken,
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(ACT_TIMEOUT_MS),
    });
  }

  async exec(command: string, opts: { cwd?: string; timeoutSec?: number; env?: Record<string, string> } = {}): Promise<VenueExecResult> {
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
    if (buf.byteLength > 2_000_000) throw new Error('Archivo demasiado grande para el venue (máx 2MB)');
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

  async browserAct(input: BrowserActInput): Promise<BrowserActResult> {
    let res: Response;
    try {
      const base = await this.controllerUrl();
      res = await this.controllerFetch(`${base}/act`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch {
      // Controller unreachable — still provisioning or it died. Include the
      // last diagnostic so the model can tell the user the real cause.
      const why = this.lastDiag ? ` Detalle: ${this.lastDiag.slice(0, 300)}` : '';
      return {
        ok: false,
        error: `El navegador de la VM aún no responde (aprovisionando o el controlador falló al arrancar). Reintenta en unos segundos; si persiste, la sesión se recreará.${why}`,
      };
    }
    const data = (await res.json().catch(() => null)) as BrowserActResult | null;
    if (!data) return { ok: false, error: `Controller respondió ${res.status}` };
    if (data.screenshotBase64 && data.screenshotBase64.length > 8_000_000) {
      data.screenshotBase64 = undefined;
      data.error = 'screenshot demasiado grande';
    }
    return data;
  }

  async stop(): Promise<void> {
    await this.sandbox.stop(60).catch(() => undefined);
  }

  async destroy(): Promise<void> {
    await this.sandbox.delete(60).catch(() => undefined);
  }
}
