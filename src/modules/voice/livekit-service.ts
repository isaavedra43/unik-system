import { randomBytes } from 'crypto';
import { z } from 'zod';
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  SipClient,
  WebhookReceiver,
  type VideoGrant,
} from 'livekit-server-sdk';
import { getStorageConfig } from '@/modules/storage/storage-config';
import { buildRecordingKey } from '@/modules/storage/storage-keys';

/**
 * LiveKit client wrapper (rooms, tokens, egress to R2, SIP, webhooks).
 *
 * - Configuration is validated lazily with Zod; error messages only name the
 *   variables, never their values.
 * - When `LIVEKIT_URL` is empty the service runs in MOCK mode: every call is
 *   simulated in memory and responses carry `mock: true`. Tests and local
 *   development rely on this; production must configure the real server.
 * - Recordings never pass through the web process: LiveKit Egress writes the
 *   file straight to the R2 "recordings" bucket (S3-compatible API).
 *
 * Supervision roles:
 * - `listen`  → subscribe only (no publish grant at all).
 * - `whisper` → publish allowed, but the token metadata carries
 *   `whisperTo: <agent identity>`. LiveKit has no server-side "audible only
 *   by one participant" audio routing, so the browser client of every other
 *   participant must ignore tracks whose publisher metadata targets someone
 *   else. This is a documented client-side limitation (see docs/voice.md).
 * - `barge`   → normal publish/subscribe (joins the conversation).
 */

const envSchema = z.object({
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  LIVEKIT_SIP_TRUNK_ID: z.string().min(1).optional(),
  /** SIP domain of the LiveKit project (e.g. `xxxx.sip.livekit.cloud`). */
  LIVEKIT_SIP_DOMAIN: z.string().min(1).optional(),
  /** Shared secret for webhooks while running in mock mode. */
  LIVEKIT_MOCK_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Optional write-only R2 token for egress uploads (recommended in production). */
  R2_EGRESS_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_EGRESS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export interface LiveKitConfig {
  mock: boolean;
  url: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  sipTrunkId: string | null;
  sipDomain: string | null;
  mockWebhookSecret: string | null;
  egressCredentials: { accessKeyId: string; secretAccessKey: string } | null;
}

export type SupervisionMode = 'listen' | 'whisper' | 'barge';
export type TokenRole = 'participant' | 'ai' | SupervisionMode;

export interface IssueTokenInput {
  identity: string;
  roomName: string;
  role: TokenRole;
  name?: string;
  /** Agent identity a whisper stream is addressed to. */
  whisperTo?: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
}

export interface IssuedToken {
  token: string;
  url: string | null;
  identity: string;
  roomName: string;
  role: TokenRole;
  grants: { canPublish: boolean; canSubscribe: boolean; hidden: boolean };
  mock: boolean;
}

export interface EgressStart {
  egressId: string;
  filepath: string;
  mock: boolean;
}

export interface MockParticipant {
  identity: string;
  role: TokenRole;
  metadata: string;
}

export interface NormalizedWebhookEvent {
  event: string;
  roomName: string | null;
  participant: { identity: string; metadata: string | null } | null;
  egress: {
    egressId: string;
    roomName: string | null;
    status: string;
    error: string | null;
    files: Array<{ filename: string; location: string; sizeBytes: number; durationMs: number }>;
  } | null;
  mock: boolean;
}

export class LiveKitError extends Error {
  constructor(
    message: string,
    public readonly code: 'config' | 'provider' | 'not_found' | 'invalid',
    public readonly status: number = 500
  ) {
    super(message);
    this.name = 'LiveKitError';
  }
}

let cachedConfig: LiveKitConfig | null = null;

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Loads and validates the LiveKit configuration lazily. Never reveals values. */
export function getLiveKitConfig(): LiveKitConfig {
  if (cachedConfig) return cachedConfig;
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) raw[key] = emptyToUndefined(process.env[key]);
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const invalid = parsed.error.issues.map((issue) => issue.path.join('.'));
    throw new LiveKitError(
      `Invalid LiveKit environment variables: ${invalid.join(', ')}`,
      'config'
    );
  }
  const env = parsed.data;
  const mock = !env.LIVEKIT_URL;
  if (!mock && (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET)) {
    throw new LiveKitError(
      'LIVEKIT_URL requires LIVEKIT_API_KEY and LIVEKIT_API_SECRET',
      'config'
    );
  }
  let sipDomain = env.LIVEKIT_SIP_DOMAIN ?? null;
  if (!sipDomain && env.LIVEKIT_URL) {
    try {
      const host = new URL(env.LIVEKIT_URL).hostname;
      // LiveKit Cloud convention: <project>.livekit.cloud → <project>.sip.livekit.cloud
      sipDomain = host.endsWith('.livekit.cloud')
        ? host.replace(/\.livekit\.cloud$/, '.sip.livekit.cloud')
        : host;
    } catch {
      sipDomain = null;
    }
  }
  cachedConfig = {
    mock,
    url: env.LIVEKIT_URL ?? null,
    apiKey: env.LIVEKIT_API_KEY ?? null,
    apiSecret: env.LIVEKIT_API_SECRET ?? null,
    sipTrunkId: env.LIVEKIT_SIP_TRUNK_ID ?? null,
    sipDomain: mock ? (sipDomain ?? 'mock.sip.local') : sipDomain,
    mockWebhookSecret: env.LIVEKIT_MOCK_WEBHOOK_SECRET ?? null,
    egressCredentials:
      env.R2_EGRESS_ACCESS_KEY_ID && env.R2_EGRESS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.R2_EGRESS_ACCESS_KEY_ID,
            secretAccessKey: env.R2_EGRESS_SECRET_ACCESS_KEY,
          }
        : null,
  };
  return cachedConfig;
}

export function resetLiveKitConfigCache(): void {
  cachedConfig = null;
}

/** Non-secret status for admin panels. */
export function getLiveKitStatus(): {
  mock: boolean;
  configured: boolean;
  sipConfigured: boolean;
  sipDomain: string | null;
  egressUsesDedicatedToken: boolean;
  missingVars: string[];
} {
  let config: LiveKitConfig;
  try {
    config = getLiveKitConfig();
  } catch {
    return {
      mock: true,
      configured: false,
      sipConfigured: false,
      sipDomain: null,
      egressUsesDedicatedToken: false,
      missingVars: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
    };
  }
  const missing: string[] = [];
  if (!config.url) missing.push('LIVEKIT_URL');
  if (!config.apiKey) missing.push('LIVEKIT_API_KEY');
  if (!config.apiSecret) missing.push('LIVEKIT_API_SECRET');
  if (!config.sipTrunkId) missing.push('LIVEKIT_SIP_TRUNK_ID');
  return {
    mock: config.mock,
    configured: !config.mock,
    sipConfigured: Boolean(config.sipTrunkId),
    sipDomain: config.sipDomain,
    egressUsesDedicatedToken: Boolean(config.egressCredentials),
    missingVars: missing,
  };
}

// ---------------------------------------------------------------------------
// Lazy real clients
// ---------------------------------------------------------------------------

type GlobalWithClients = typeof globalThis & {
  __unikLiveKit?: {
    room?: RoomServiceClient;
    egress?: EgressClient;
    sip?: SipClient;
    webhook?: WebhookReceiver;
  };
};

function clients() {
  const scope = globalThis as GlobalWithClients;
  if (!scope.__unikLiveKit) scope.__unikLiveKit = {};
  return scope.__unikLiveKit;
}

function requireReal(): { url: string; apiKey: string; apiSecret: string } {
  const config = getLiveKitConfig();
  if (config.mock || !config.url || !config.apiKey || !config.apiSecret) {
    throw new LiveKitError('LiveKit no está configurado', 'config', 503);
  }
  return { url: config.url, apiKey: config.apiKey, apiSecret: config.apiSecret };
}

function roomClient(): RoomServiceClient {
  const c = clients();
  if (!c.room) {
    const { url, apiKey, apiSecret } = requireReal();
    c.room = new RoomServiceClient(url, apiKey, apiSecret);
  }
  return c.room;
}

function egressClient(): EgressClient {
  const c = clients();
  if (!c.egress) {
    const { url, apiKey, apiSecret } = requireReal();
    c.egress = new EgressClient(url, apiKey, apiSecret);
  }
  return c.egress;
}

function sipClient(): SipClient {
  const c = clients();
  if (!c.sip) {
    const { url, apiKey, apiSecret } = requireReal();
    c.sip = new SipClient(url, apiKey, apiSecret);
  }
  return c.sip;
}

function webhookReceiver(): WebhookReceiver {
  const c = clients();
  if (!c.webhook) {
    const { apiKey, apiSecret } = requireReal();
    c.webhook = new WebhookReceiver(apiKey, apiSecret);
  }
  return c.webhook;
}

// ---------------------------------------------------------------------------
// Mock state (in memory, per process)
// ---------------------------------------------------------------------------

interface MockRoom {
  name: string;
  createdAt: Date;
  participants: Map<string, MockParticipant>;
}

interface MockEgress {
  egressId: string;
  roomName: string;
  filepath: string;
  status: 'active' | 'ended';
}

type GlobalWithMock = typeof globalThis & {
  __unikLiveKitMock?: { rooms: Map<string, MockRoom>; egresses: Map<string, MockEgress> };
};

function mockState() {
  const scope = globalThis as GlobalWithMock;
  if (!scope.__unikLiveKitMock) {
    scope.__unikLiveKitMock = { rooms: new Map(), egresses: new Map() };
  }
  return scope.__unikLiveKitMock;
}

/** Test helper: clears the in-memory mock server. */
export function resetLiveKitMockForTests(): void {
  const scope = globalThis as GlobalWithMock;
  scope.__unikLiveKitMock = { rooms: new Map(), egresses: new Map() };
  cachedConfig = null;
}

/** Test helper: inspects the mock server. */
export function getLiveKitMockState(): {
  rooms: Array<{ name: string; participants: MockParticipant[] }>;
  egresses: MockEgress[];
} {
  const state = mockState();
  return {
    rooms: [...state.rooms.values()].map((r) => ({
      name: r.name,
      participants: [...r.participants.values()],
    })),
    egresses: [...state.egresses.values()],
  };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export function roomNameForCall(callId: string): string {
  return `call-${callId}`;
}

export async function createRoom(
  callId: string,
  options: { emptyTimeoutSeconds?: number; maxParticipants?: number } = {}
): Promise<{ roomName: string; mock: boolean }> {
  const roomName = roomNameForCall(callId);
  const config = getLiveKitConfig();
  if (config.mock) {
    mockState().rooms.set(roomName, { name: roomName, createdAt: new Date(), participants: new Map() });
    return { roomName, mock: true };
  }
  try {
    await roomClient().createRoom({
      name: roomName,
      emptyTimeout: options.emptyTimeoutSeconds ?? 120,
      departureTimeout: 30,
      maxParticipants: options.maxParticipants ?? 12,
      metadata: JSON.stringify({ callId }),
    });
  } catch (err) {
    throw new LiveKitError(
      `No se pudo crear la sala: ${err instanceof Error ? err.message : 'error'}`,
      'provider',
      502
    );
  }
  return { roomName, mock: false };
}

export async function deleteRoom(roomName: string): Promise<{ mock: boolean }> {
  const config = getLiveKitConfig();
  if (config.mock) {
    mockState().rooms.delete(roomName);
    return { mock: true };
  }
  try {
    await roomClient().deleteRoom(roomName);
  } catch {
    // Room may already be gone; ending a call must not fail because of it.
  }
  return { mock: false };
}

export async function listRooms(): Promise<{ rooms: Array<{ name: string; numParticipants: number }>; mock: boolean }> {
  const config = getLiveKitConfig();
  if (config.mock) {
    return {
      rooms: [...mockState().rooms.values()].map((r) => ({
        name: r.name,
        numParticipants: r.participants.size,
      })),
      mock: true,
    };
  }
  const rooms = await roomClient().listRooms();
  return {
    rooms: rooms.map((r) => ({ name: r.name, numParticipants: r.numParticipants })),
    mock: false,
  };
}

export async function listParticipants(
  roomName: string
): Promise<{ participants: Array<{ identity: string; metadata: string | null }>; mock: boolean }> {
  const config = getLiveKitConfig();
  if (config.mock) {
    const room = mockState().rooms.get(roomName);
    return {
      participants: room
        ? [...room.participants.values()].map((p) => ({ identity: p.identity, metadata: p.metadata }))
        : [],
      mock: true,
    };
  }
  const list = await roomClient().listParticipants(roomName);
  return {
    participants: list.map((p) => ({ identity: p.identity, metadata: p.metadata || null })),
    mock: false,
  };
}

export async function removeParticipant(
  roomName: string,
  identity: string
): Promise<{ mock: boolean }> {
  const config = getLiveKitConfig();
  if (config.mock) {
    mockState().rooms.get(roomName)?.participants.delete(identity);
    return { mock: true };
  }
  try {
    await roomClient().removeParticipant(roomName, identity);
  } catch (err) {
    throw new LiveKitError(
      `No se pudo retirar al participante: ${err instanceof Error ? err.message : 'error'}`,
      'provider',
      502
    );
  }
  return { mock: false };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function grantsForRole(role: TokenRole): { canPublish: boolean; canSubscribe: boolean; hidden: boolean } {
  switch (role) {
    case 'listen':
      return { canPublish: false, canSubscribe: true, hidden: true };
    case 'whisper':
      return { canPublish: true, canSubscribe: true, hidden: true };
    case 'barge':
      return { canPublish: true, canSubscribe: true, hidden: false };
    case 'ai':
    case 'participant':
    default:
      return { canPublish: true, canSubscribe: true, hidden: false };
  }
}

/**
 * Issues a room token. The caller (voice-service) is responsible for the
 * authorization decision; this function never checks permissions and must
 * not be reachable from routes directly.
 */
export async function issueToken(input: IssueTokenInput): Promise<IssuedToken> {
  const config = getLiveKitConfig();
  const grants = grantsForRole(input.role);
  const metadata = JSON.stringify({
    role: input.role,
    ...(input.whisperTo ? { whisperTo: input.whisperTo } : {}),
    ...(input.metadata ?? {}),
  });
  if (config.mock) {
    const room = mockState().rooms.get(input.roomName);
    if (room) {
      room.participants.set(input.identity, { identity: input.identity, role: input.role, metadata });
    }
    const token = `mock.${Buffer.from(
      JSON.stringify({ identity: input.identity, room: input.roomName, role: input.role, grants })
    ).toString('base64url')}.${randomBytes(6).toString('hex')}`;
    return {
      token,
      url: null,
      identity: input.identity,
      roomName: input.roomName,
      role: input.role,
      grants,
      mock: true,
    };
  }
  const { apiKey, apiSecret, url } = requireReal();
  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: input.ttlSeconds ?? 60 * 60,
    metadata,
  });
  const grant: VideoGrant = {
    room: input.roomName,
    roomJoin: true,
    canPublish: grants.canPublish,
    canSubscribe: grants.canSubscribe,
    canPublishData: grants.canPublish,
    hidden: grants.hidden,
    canUpdateOwnMetadata: false,
  };
  at.addGrant(grant);
  return {
    token: await at.toJwt(),
    url,
    identity: input.identity,
    roomName: input.roomName,
    role: input.role,
    grants,
    mock: false,
  };
}

// ---------------------------------------------------------------------------
// Egress (recording) → R2
// ---------------------------------------------------------------------------

/**
 * Starts a room composite egress writing directly to the R2 recordings
 * bucket. The upload credentials are the storage R2 credentials unless
 * `R2_EGRESS_*` provides a dedicated write-only token (recommended: the
 * egress server only needs PutObject on the recordings bucket).
 */
export async function startRecording(
  callId: string,
  roomName: string,
  recordingId: string = randomBytes(8).toString('hex')
): Promise<EgressStart> {
  const filepath = buildRecordingKey(callId, recordingId);
  const config = getLiveKitConfig();
  if (config.mock) {
    const egressId = `EG_mock_${randomBytes(6).toString('hex')}`;
    mockState().egresses.set(egressId, { egressId, roomName, filepath, status: 'active' });
    return { egressId, filepath, mock: true };
  }
  const storage = getStorageConfig();
  if (!storage.r2) {
    throw new LiveKitError(
      'La grabación requiere almacenamiento R2 (STORAGE_DRIVER=r2)',
      'config',
      503
    );
  }
  const creds = config.egressCredentials ?? {
    accessKeyId: storage.r2.accessKeyId,
    secretAccessKey: storage.r2.secretAccessKey,
  };
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath,
    disableManifest: true,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: creds.accessKeyId,
        secret: creds.secretAccessKey,
        endpoint: storage.r2.endpoint,
        bucket: storage.buckets.recordings,
        region: 'auto',
        forcePathStyle: storage.r2.forcePathStyle,
      }),
    },
  });
  try {
    const info = await egressClient().startRoomCompositeEgress(roomName, output, {
      audioOnly: true,
    });
    return { egressId: info.egressId, filepath, mock: false };
  } catch (err) {
    throw new LiveKitError(
      `No se pudo iniciar la grabación: ${err instanceof Error ? err.message : 'error'}`,
      'provider',
      502
    );
  }
}

export async function stopRecording(egressId: string): Promise<{ mock: boolean }> {
  const config = getLiveKitConfig();
  if (config.mock) {
    const egress = mockState().egresses.get(egressId);
    if (egress) egress.status = 'ended';
    return { mock: true };
  }
  try {
    await egressClient().stopEgress(egressId);
  } catch (err) {
    throw new LiveKitError(
      `No se pudo detener la grabación: ${err instanceof Error ? err.message : 'error'}`,
      'provider',
      502
    );
  }
  return { mock: false };
}

// ---------------------------------------------------------------------------
// SIP (Twilio ↔ LiveKit)
// ---------------------------------------------------------------------------

/** SIP URI Twilio dials to bridge a PSTN call into the call's room. */
export function buildInboundSipUri(callId: string): string {
  const config = getLiveKitConfig();
  if (!config.sipDomain) {
    throw new LiveKitError('LIVEKIT_SIP_DOMAIN no está configurado', 'config', 503);
  }
  return `sip:${callId}@${config.sipDomain}`;
}

export async function sipCreateOutbound(
  callId: string,
  roomName: string,
  toNumber: string,
  participantIdentity: string
): Promise<{ participantId: string; mock: boolean }> {
  const config = getLiveKitConfig();
  if (config.mock) {
    const room = mockState().rooms.get(roomName);
    room?.participants.set(participantIdentity, {
      identity: participantIdentity,
      role: 'participant',
      metadata: JSON.stringify({ sip: true, callId }),
    });
    return { participantId: `PA_mock_${randomBytes(4).toString('hex')}`, mock: true };
  }
  if (!config.sipTrunkId) {
    throw new LiveKitError('LIVEKIT_SIP_TRUNK_ID no está configurado', 'config', 503);
  }
  try {
    const info = await sipClient().createSipParticipant(config.sipTrunkId, toNumber, roomName, {
      participantIdentity,
      participantMetadata: JSON.stringify({ sip: true, callId }),
      playDialtone: true,
      hidePhoneNumber: true,
      ringingTimeout: 45,
    });
    return { participantId: info.participantId, mock: false };
  } catch (err) {
    throw new LiveKitError(
      `No se pudo iniciar la llamada saliente: ${err instanceof Error ? err.message : 'error'}`,
      'provider',
      502
    );
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const mockWebhookSchema = z.object({
  event: z.string().min(1),
  room: z.object({ name: z.string() }).optional(),
  participant: z
    .object({ identity: z.string(), metadata: z.string().optional() })
    .optional(),
  egressInfo: z
    .object({
      egressId: z.string(),
      roomName: z.string().optional(),
      status: z.union([z.string(), z.number()]).optional(),
      error: z.string().optional(),
      fileResults: z
        .array(
          z.object({
            filename: z.string(),
            location: z.string().optional(),
            size: z.union([z.string(), z.number(), z.bigint()]).optional(),
            duration: z.union([z.string(), z.number(), z.bigint()]).optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

function toNumber(value: string | number | bigint | undefined): number {
  if (value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Verifies and normalizes a LiveKit webhook. Real mode uses the SDK
 * `WebhookReceiver` (JWT in the `Authorization` header signed with the API
 * secret). Mock mode requires `X-Livekit-Mock-Secret` to equal
 * `LIVEKIT_MOCK_WEBHOOK_SECRET`; without that variable mock webhooks are
 * rejected.
 */
export async function receiveWebhook(
  body: string,
  headers: { authorization?: string | null; mockSecret?: string | null }
): Promise<NormalizedWebhookEvent> {
  const config = getLiveKitConfig();
  if (config.mock) {
    if (!config.mockWebhookSecret || headers.mockSecret !== config.mockWebhookSecret) {
      throw new LiveKitError('Webhook no autorizado', 'invalid', 401);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new LiveKitError('JSON inválido', 'invalid', 400);
    }
    const parsed = mockWebhookSchema.safeParse(json);
    if (!parsed.success) throw new LiveKitError('Evento inválido', 'invalid', 400);
    const e = parsed.data;
    return {
      event: e.event,
      roomName: e.room?.name ?? e.egressInfo?.roomName ?? null,
      participant: e.participant
        ? { identity: e.participant.identity, metadata: e.participant.metadata ?? null }
        : null,
      egress: e.egressInfo
        ? {
            egressId: e.egressInfo.egressId,
            roomName: e.egressInfo.roomName ?? null,
            status: String(e.egressInfo.status ?? ''),
            error: e.egressInfo.error || null,
            files: (e.egressInfo.fileResults ?? []).map((f) => ({
              filename: f.filename,
              location: f.location ?? '',
              sizeBytes: toNumber(f.size),
              durationMs: Math.round(toNumber(f.duration) / 1_000_000),
            })),
          }
        : null,
      mock: true,
    };
  }
  let event;
  try {
    event = await webhookReceiver().receive(body, headers.authorization ?? undefined);
  } catch {
    throw new LiveKitError('Webhook no autorizado', 'invalid', 401);
  }
  return {
    event: event.event,
    roomName: event.room?.name ?? event.egressInfo?.roomName ?? null,
    participant: event.participant
      ? { identity: event.participant.identity, metadata: event.participant.metadata || null }
      : null,
    egress: event.egressInfo
      ? {
          egressId: event.egressInfo.egressId,
          roomName: event.egressInfo.roomName || null,
          status: String(event.egressInfo.status),
          error: event.egressInfo.error || null,
          files: event.egressInfo.fileResults.map((f) => ({
            filename: f.filename,
            location: f.location,
            sizeBytes: Number(f.size),
            durationMs: Math.round(Number(f.duration) / 1_000_000),
          })),
        }
      : null,
    mock: false,
  };
}
