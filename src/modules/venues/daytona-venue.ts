import { readFileSync } from 'node:fs';
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

let controllerScriptCache: string | null = null;
function controllerScript(): string {
  if (controllerScriptCache) return controllerScriptCache;
  controllerScriptCache = readFileSync(
    path.join(__dirname, 'assets', 'browser-controller.mjs'),
    'utf8'
  );
  return controllerScriptCache;
}

let provisionScriptCache: string | null = null;
function provisionScript(): string {
  if (provisionScriptCache) return provisionScriptCache;
  provisionScriptCache = readFileSync(
    path.join(__dirname, 'assets', 'provision.sh'),
    'utf8'
  );
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
    // Controller may not be running (sandbox was stopped) — ensure it is.
    await venue.startController().catch(() => null);
    return venue;
  }

  private chromePath = '/usr/bin/chromium';

  private async startController(): Promise<void> {
    await this.sandbox.fs.createFolder(CONTROLLER_REMOTE_DIR, '755').catch(() => undefined);
    await this.sandbox.fs.uploadFile(Buffer.from(provisionScript(), 'utf8'), PROVISION_REMOTE_PATH);
    await this.sandbox.fs.uploadFile(Buffer.from(controllerScript(), 'utf8'), CONTROLLER_REMOTE_PATH);

    // Provision the browser stack (playwright-core + chromium). Stock sandbox
    // images don't ship them; without this the controller can't even import.
    // Bounded and best-effort — non-browser tools (exec/files) don't need it.
    try {
      const prov = await this.sandbox.process.executeCommand(
        `bash ${PROVISION_REMOTE_PATH}`,
        CONTROLLER_REMOTE_DIR,
        {},
        280
      );
      const m = /UNIK_CHROME_PATH=(\S+)/.exec(prov.result ?? '');
      if (m?.[1]) this.chromePath = m[1];
    } catch {
      // Provision timed out or failed — health check below reports the rest.
    }

    // Start detached so executeCommand returns immediately.
    await this.sandbox.process.executeCommand(
      `cd ${CONTROLLER_REMOTE_DIR} && nohup node browser-controller.mjs > controller.log 2>&1 &`,
      CONTROLLER_REMOTE_DIR,
      { UNIK_BROWSER_TOKEN: this.controllerToken, UNIK_CHROME_PATH: this.chromePath },
      10
    );
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
    // Not fatal — browser acts will retry the URL lazily. Surface why, though:
    // the caller/user needs the real reason (missing chromium, OOM, etc).
    try {
      const diag = await this.exec(
        `tail -20 ${CONTROLLER_REMOTE_DIR}/controller.log; node --version 2>&1; command -v chromium; ls ${CONTROLLER_REMOTE_DIR}/node_modules 2>/dev/null | head`,
        { timeoutSec: 15 }
      );
      console.error('[venue] browser controller did not reach health:', diag.stdout.slice(0, 800));
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
      signal: AbortSignal.timeout(ACT_TIMEOUT_MS),
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
    const shot = await this.sandbox.computerUse.screenshot.takeCompressed({
      showCursor: true,
      format: 'jpeg',
      quality: 70,
    });
    const b64 = shot.screenshot ?? '';
    return { imageBase64: b64, mimeType: 'image/jpeg' };
  }

  async browserAct(input: BrowserActInput): Promise<BrowserActResult> {
    const base = await this.controllerUrl();
    const res = await this.controllerFetch(`${base}/act`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
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
