/**
 * Venue — a disposable remote computer the assistant can operate.
 *
 * Two DIFFERENT surfaces live in one sandbox and are exposed separately:
 *   - the BROWSER: a Playwright-driven Chromium (headless) the agent reads and
 *     operates through element references (`snapshot` → `click {ref}`), and
 *     the user can take over from the workspace (click/type on the live frame);
 *   - the COMPUTER: a real Linux desktop (Xvfb + xfce + VNC through Daytona
 *     ComputerUse) with mouse, keyboard, screenshots, accessibility tree,
 *     terminal and files.
 *
 * The ONLY implementation today is Daytona; the interface exists so a second
 * provider (companion Mac, E2B…) can slot in without touching tools.
 *
 * Security contract:
 *   - Everything the venue returns is untrusted content.
 *   - Credentials are never passed in `exec`/`browserAct` arguments — they go
 *     through `useCredential` (secretValue resolved server-side) and are typed
 *     by the controller, never logged nor framed.
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

export type BrowserAction =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'select'
  | 'hover'
  | 'press'
  | 'scroll'
  | 'extract'
  | 'screenshot'
  | 'pdf'
  | 'tabs'
  | 'newTab'
  | 'switchTab'
  | 'closeTab'
  | 'waitFor'
  | 'submit'
  | 'evaluate'
  | 'console'
  | 'upload'
  | 'useCredential'
  | 'captureState'
  | 'applyState'
  // User takeover from the workspace (coordinates are in page CSS pixels).
  | 'clickAt'
  | 'typeText'
  | 'key'
  | 'wheel'
  | 'frame'
  /**
   * Handled entirely by the tool layer (secure user-takeover form) — the
   * browser tool returns before ever calling browserAct with it. Listed here
   * so the tool's input type covers its full surface.
   */
  | 'secureInput';

export interface BrowserActInput {
  action: BrowserAction;
  url?: string;
  /** Element reference from the last `snapshot` (preferred over selectors). */
  ref?: number;
  selector?: string;
  /** Visible text of the element to act on (fallback when there is no ref). */
  target?: string;
  text?: string;
  key?: string;
  /** select: option label or value. */
  value?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** clickAt / wheel (page CSS pixels). */
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  /** extract: 'readable' | css selector */
  extractMode?: string;
  /** evaluate: JS expression evaluated in the page (result must be JSON-serializable). */
  script?: string;
  /** upload: file paths INSIDE the sandbox. */
  files?: string[];
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
  /** frame/screenshot quality (1-90). */
  quality?: number;
}

export interface BrowserElement {
  ref: number;
  role: string;
  name: string;
  tag: string;
  type?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserActResult {
  ok: boolean;
  error?: string;
  /** Current page state after the action. */
  url?: string;
  title?: string;
  /** extract / snapshot text (markdown-ish). */
  content?: string;
  /** snapshot: interactive elements with refs usable by click/type/select. */
  elements?: BrowserElement[];
  screenshotBase64?: string;
  /** Viewport size in CSS pixels — maps clicks on the live frame. */
  viewport?: { width: number; height: number };
  /**
   * The frame may show secrets typed through useCredential (card numbers are
   * not masked by pages). Such frames never reach the model.
   */
  frameSensitive?: boolean;
  /** data:application/pdf;base64 → uploaded to storage by the tool layer. */
  pdfBase64?: string;
  /** captureState result — serialized storageState JSON (internal). */
  stateJson?: string;
  tabs?: BrowserTab[];
  /** console: page errors, failed requests and console messages (QA testing). */
  logs?: Array<{ level: string; text: string; url?: string; at: string }>;
  /** evaluate result (JSON). */
  value?: unknown;
  /** Files the page downloaded (paths inside the sandbox). */
  downloads?: string[];
  /** clickAt/typeText: the element the user acted on (teach-mode recording). */
  hit?: {
    selector: string;
    text: string;
    tag: string;
    type?: string;
    sensitive?: boolean;
  } | null;
  /** frame/snapshot with no tab open yet. */
  empty?: boolean;
}

export type DesktopAction =
  | 'screenshot'
  | 'click'
  | 'doubleClick'
  | 'rightClick'
  | 'move'
  | 'drag'
  | 'scroll'
  | 'type'
  | 'key'
  | 'hotkey'
  | 'openApp'
  | 'windows'
  | 'find'
  | 'invoke'
  | 'setValue'
  | 'wait';

export interface DesktopActInput {
  action: DesktopAction;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  direction?: 'up' | 'down';
  amount?: number;
  text?: string;
  /** key: 'Return', 'Tab', 'ctrl+c'… (xdotool names). */
  key?: string;
  /** openApp: command to launch on the desktop (e.g. "xfce4-terminal", "firefox"). */
  command?: string;
  /** find: accessibility query (role/name). invoke/setValue: node id. */
  role?: string;
  name?: string;
  nodeId?: string;
  value?: string;
  seconds?: number;
  quality?: number;
}

export interface DesktopActResult {
  ok: boolean;
  error?: string;
  screenshotBase64?: string;
  width?: number;
  height?: number;
  windows?: Array<{ id: string; title: string; active?: boolean }>;
  nodes?: Array<{ id: string; role: string; name: string; bounds?: unknown }>;
  cursor?: { x: number; y: number };
}

export interface VenueHealth {
  /** true when the in-venue browser controller answers. */
  ok: boolean;
  /** Why it does not (provisioning output, controller log) — for the panel and the model. */
  reason?: string;
  /** Short machine stage for the panel's boot progress. */
  stage?: VenueBootStage;
}

export type VenueBootStage =
  | 'creating'
  | 'uploading'
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'failed';

export interface DesktopStatus {
  running: boolean;
  /** Why the desktop is unavailable (image without VNC stack, start failed…). */
  reason?: string;
}

export interface Venue {
  /** VenueSession.id in our DB. */
  readonly id: string;
  /** Provider sandbox id. */
  readonly externalId: string;
  readonly kind: string;
  /** Provider state ('started', 'stopped', 'starting'…) when known. */
  readonly sandboxState?: string;

  /** Cheap probe of the browser controller — never provisions. */
  health(): Promise<VenueHealth>;
  /** Kick the browser stack (provision + controller) — serialized per sandbox. */
  ensureBrowser(): Promise<boolean>;
  exec(
    command: string,
    opts?: { cwd?: string; timeoutSec?: number; env?: Record<string, string> }
  ): Promise<VenueExecResult>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  readFileBuffer(path: string, maxBytes?: number): Promise<Buffer>;
  writeFile(path: string, content: string | Buffer): Promise<void>;
  listFiles(path: string): Promise<VenueFileEntry[]>;
  screenshot(): Promise<VenueScreenshot>;
  browserAct(input: BrowserActInput): Promise<BrowserActResult>;
  /** Real desktop (VNC). */
  desktopStatus(): Promise<DesktopStatus>;
  ensureDesktop(): Promise<DesktopStatus>;
  desktopAct(input: DesktopActInput): Promise<DesktopActResult>;
  /** Signed noVNC URL to open the desktop in its own browser tab. */
  desktopViewerUrl(): Promise<string | null>;
  /** Signed preview URL of a port served inside the sandbox (apps the agent builds). */
  previewUrl(port: number, ttlSeconds?: number): Promise<string>;
  /** Graceful stop (sandbox kept for restart). */
  stop(): Promise<void>;
  /** Hard delete — killswitch path. */
  destroy(): Promise<void>;
}
