/**
 * Venue — a disposable remote computer the assistant can operate.
 *
 * The ONLY implementation today is Daytona; the interface exists so a second
 * provider (companion Mac, E2B…) can slot in without touching tools.
 *
 * Security contract:
 *   - Everything the venue returns is untrusted content.
 *   - Credentials are never passed in `exec`/`browserAct` arguments — they go
 *     through `injectSecret` and are typed by the controller, never logged.
 *   - `exec` runs inside the sandbox only; the app server never shells out.
 */

export interface VenueExecResult {
  exitCode: number;
  stdout: string;
}

export interface VenueFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface VenueScreenshot {
  /** Base64-encoded PNG/JPEG. */
  imageBase64: string;
  mimeType: 'image/png' | 'image/jpeg';
  width?: number;
  height?: number;
}

export interface BrowserActInput {
  action:
    | 'open'
    | 'back'
    | 'forward'
    | 'click'
    | 'type'
    | 'press'
    | 'scroll'
    | 'extract'
    | 'screenshot'
    | 'pdf'
    | 'tabs'
    | 'newTab'
    | 'closeTab'
    | 'waitFor'
    | 'submit'
    | 'useCredential'
    | 'captureState'
    | 'applyState'
    /**
     * Handled entirely by the tool layer (secure user-takeover form) — the
     * browser tool returns before ever calling browserAct with it. Listed here
     * so the tool's input type covers its full surface.
     */
    | 'secureInput';
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** extract: 'readable' | css selector */
  extractMode?: string;
  tabId?: string;
  timeoutMs?: number;
  /**
   * Credential reference (BrowserProfile id + field) — resolved server-side;
   * the raw secret travels to the sandbox inside the act payload only.
   */
  credentialId?: string;
  /**
   * Populated by the tool layer after resolving `credentialId` — the plaintext
   * secret delivered one-time to the controller. Never persisted, never logged.
   */
  secretValue?: string;
  /** Filled by resolveEffect-time snapshot for approval binding. */
  intent?: string;
  /** applyState: serialized storageState JSON (internal — never model-visible). */
  stateJson?: string;
}

export interface BrowserActResult {
  ok: boolean;
  error?: string;
  /** Current page state after the action. */
  url?: string;
  title?: string;
  /** extract result (markdown or selector text) */
  content?: string;
  screenshotBase64?: string;
  /** data:application/pdf;base64 → uploaded to R2 by the tool layer. */
  pdfBase64?: string;
  /** captureState result — serialized storageState JSON (internal). */
  stateJson?: string;
  tabs?: Array<{ id: string; url: string; title: string; active: boolean }>;
}

export interface VenueHealth {
  /** true when the in-venue browser controller answers. */
  ok: boolean;
  /** Why it does not (provisioning output, controller log) — for the panel and the model. */
  reason?: string;
}

export interface Venue {
  /** VenueSession.id in our DB. */
  readonly id: string;
  /** Provider sandbox id. */
  readonly externalId: string;
  readonly kind: string;

  /** Cheap probe of the browser controller — never provisions. */
  health(): Promise<VenueHealth>;
  exec(
    command: string,
    opts?: { cwd?: string; timeoutSec?: number; env?: Record<string, string> }
  ): Promise<VenueExecResult>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  writeFile(path: string, content: string | Buffer): Promise<void>;
  listFiles(path: string): Promise<VenueFileEntry[]>;
  screenshot(): Promise<VenueScreenshot>;
  browserAct(input: BrowserActInput): Promise<BrowserActResult>;
  /** Graceful stop (sandbox kept for restart). */
  stop(): Promise<void>;
  /** Hard delete — killswitch path. */
  destroy(): Promise<void>;
}
