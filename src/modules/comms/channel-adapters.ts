import type { CommAccount } from '@prisma/client';

/**
 * Channel adapter contract shared by the inbox (Twilio WhatsApp/SMS, Telegram)
 * and the campaign engine. Adapters register themselves at import time; the
 * dispatcher below is the ONLY door outbound messages leave through, so
 * consent, approval and budget checks happen in one place (comms-service /
 * campaign engine), never inside an adapter.
 *
 * Adapters must send credentials through the encrypted ExtensionConnection
 * referenced by `account.connectionId` (or the documented env fallback) and
 * must make every network call through `safeFetch` with an explicit host
 * policy. They never log message bodies or secrets.
 */

export type CommProvider = 'twilio_whatsapp' | 'twilio_sms' | 'telegram';

export interface OutboundMessage {
  /** Destination identifier: E.164 phone (Twilio) or Telegram chat id. */
  to: string;
  body: string;
  /** Storage object ids of READY media; the adapter resolves short-lived URLs via authorizeDownload. */
  mediaObjectIds?: string[];
  /** Provider template (WhatsApp content SID / template key) when required outside the 24h window. */
  templateKey?: string;
  templateVariables?: Record<string, string>;
  /** Idempotency key: adapters must not send twice for the same key when they can detect it. */
  idempotencyKey: string;
}

export interface OutboundResult {
  externalId: string | null;
  /** queued | sent | failed */
  status: 'queued' | 'sent' | 'failed';
  error?: string;
  /** True when the provider could not confirm the outcome (timeout after request). */
  uncertain?: boolean;
  providerMeta?: Record<string, unknown>;
  /** Estimated cost in the account currency when the provider returns it. */
  cost?: number;
}

export interface InboundMessage {
  externalId: string;
  from: string;
  fromName?: string;
  body: string | null;
  media: Array<{ url: string; contentType: string; fileName?: string }>;
  receivedAt: Date;
  providerMeta?: Record<string, unknown>;
}

export interface DeliveryUpdate {
  externalId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered';
  error?: string;
  at: Date;
}

export interface ChannelAdapter {
  readonly provider: CommProvider;
  send(account: CommAccount, message: OutboundMessage): Promise<OutboundResult>;
  /**
   * Parses and authenticates an inbound webhook (signature/secret token).
   * Returns null when the payload is not for this adapter or is invalid.
   */
  parseWebhook(account: CommAccount | null, request: { headers: Record<string, string>; rawBody: string; url: string }): Promise<{ messages: InboundMessage[]; deliveries: DeliveryUpdate[] } | null>;
  /** Lightweight configuration check (no message is sent). */
  testConnection(account: CommAccount): Promise<{ ok: boolean; detail: string }>;
}

const adapters = new Map<CommProvider, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getChannelAdapter(provider: string): ChannelAdapter {
  const adapter = adapters.get(provider as CommProvider);
  if (!adapter) throw new Error(`No hay adaptador para el proveedor ${provider}`);
  return adapter;
}

export function listChannelProviders(): CommProvider[] {
  return [...adapters.keys()];
}

/** In-memory adapter for local tests and rehearsals: records what would be sent. */
export class MockChannelAdapter implements ChannelAdapter {
  readonly provider: CommProvider;
  readonly sent: Array<{ accountId: string; message: OutboundMessage }> = [];
  constructor(provider: CommProvider = 'twilio_whatsapp', private readonly failFor: (m: OutboundMessage) => string | null = () => null) {
    this.provider = provider;
  }
  async send(account: CommAccount, message: OutboundMessage): Promise<OutboundResult> {
    const error = this.failFor(message);
    if (error) return { externalId: null, status: 'failed', error };
    this.sent.push({ accountId: account.id, message });
    return { externalId: `mock-${this.sent.length}`, status: 'sent', cost: 0.01 };
  }
  async parseWebhook(): Promise<null> {
    return null;
  }
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'mock' };
  }
}
