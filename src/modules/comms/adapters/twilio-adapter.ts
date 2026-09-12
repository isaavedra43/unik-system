import { createHmac } from 'crypto';
import type { CommAccount } from '@prisma/client';
import { readConnectionSecret } from '@/modules/extensions/connections-service';
import { EgressError, safeFetch } from '@/modules/extensions/safe-fetch';
import { authorizeDownload, getStorageObject } from '@/modules/storage/storage-service';
import {
  registerChannelAdapter,
  type ChannelAdapter,
  type CommProvider,
  type DeliveryUpdate,
  type InboundMessage,
  type OutboundMessage,
  type OutboundResult,
} from '../channel-adapters';
import { normalizePhone, stripChannelPrefix, timingSafeEqualString } from '../normalize';
import {
  fileNameFromContentType,
  INBOUND_MEDIA_CONTENT_TYPES,
  INBOUND_MEDIA_MAX_BYTES,
  SendIdempotencyCache,
  type MediaCapableAdapter,
  type MediaFetchResult,
} from './media';

/**
 * Twilio Programmable Messaging adapter (WhatsApp and SMS).
 *
 * - Outbound: POST /2010-04-01/Accounts/{sid}/Messages.json with Basic auth.
 *   Media is passed as short-lived signed URLs from the object storage.
 * - Inbound: form-encoded webhooks authenticated with X-Twilio-Signature
 *   (HMAC-SHA1 over the public URL + sorted params, base64), compared in
 *   constant time. Status callbacks share the same endpoint.
 * - Credentials come from the encrypted connection referenced by the
 *   account, falling back to TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.
 */

export const TWILIO_API_HOST = 'api.twilio.com';
const TWILIO_MEDIA_HOSTS = [
  TWILIO_API_HOST,
  'media.twiliocdn.com',
  '*.twiliocdn.com',
  's3-external-1.amazonaws.com',
  '*.amazonaws.com',
];

interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export async function resolveTwilioCredentials(
  account: Pick<CommAccount, 'connectionId'> | null
): Promise<TwilioCredentials> {
  if (account?.connectionId) {
    const secret = await readConnectionSecret(account.connectionId);
    if (secret.username && secret.password) {
      return { accountSid: secret.username, authToken: secret.password };
    }
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio no está configurado (conexión cifrada o TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)'
    );
  }
  return { accountSid, authToken };
}

function basicAuth(creds: TwilioCredentials): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
}

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + Σ sorted(key + value))).
 * Repeated keys append each value in sorted order (same as the official helper).
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]>
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const v of [...value].sort()) data += key + v;
    } else {
      data += key + value;
    }
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function parseFormBody(rawBody: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const search = new URLSearchParams(rawBody);
  for (const [key, value] of search.entries()) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

function first(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Public URL Twilio signed: configured base + path/query of the received request. */
export function resolveTwilioWebhookUrl(
  requestUrl: string,
  base = process.env.TWILIO_WEBHOOK_BASE_URL,
  headers: Record<string, string> = {}
): string {
  const incoming = new URL(requestUrl);
  // Behind Railway/other proxies the internal URL carries http:// and a port;
  // fall back to the forwarded host/proto when no explicit base is configured.
  if (!base) {
    const host = headers['x-forwarded-host'] ?? headers.host;
    const proto = headers['x-forwarded-proto'] ?? 'https';
    if (host) base = `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
  }
  if (!base) return requestUrl;
  return `${base.replace(/\/+$/, '')}${incoming.pathname}${incoming.search}`;
}

function mapOutboundStatus(status: string | undefined): OutboundResult['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'sent':
    case 'delivered':
    case 'read':
      return 'sent';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'failed';
    default:
      return 'queued';
  }
}

function mapDeliveryStatus(status: string): DeliveryUpdate['status'] | null {
  switch (status.toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    case 'undelivered':
      return 'undelivered';
    default:
      return null;
  }
}

function addressFor(provider: string, identifier: string): string {
  const e164 = normalizePhone(identifier) ?? stripChannelPrefix(identifier);
  return provider === 'twilio_whatsapp' ? `whatsapp:${e164}` : e164;
}

async function mediaUrlsFor(objectIds: string[]): Promise<{ urls: string[]; error?: string }> {
  const urls: string[] = [];
  for (const id of objectIds) {
    const object = await getStorageObject(id);
    if (!object || object.status !== 'ready') return { urls, error: 'Adjunto no disponible' };
    const auth = await authorizeDownload(object, { disposition: 'inline' });
    if (auth.mode !== 'signed') {
      return {
        urls,
        error:
          'El almacenamiento no puede emitir URLs firmadas para que Twilio descargue el adjunto',
      };
    }
    urls.push(auth.url);
  }
  return { urls };
}

class TwilioAdapter implements MediaCapableAdapter {
  private readonly cache = new SendIdempotencyCache<OutboundResult>();

  constructor(readonly provider: CommProvider) {}

  async send(account: CommAccount, message: OutboundMessage): Promise<OutboundResult> {
    const cached = this.cache.get(message.idempotencyKey);
    if (cached) return cached;

    let creds: TwilioCredentials;
    try {
      creds = await resolveTwilioCredentials(account);
    } catch (err) {
      return { externalId: null, status: 'failed', error: (err as Error).message };
    }
    const to = normalizePhone(message.to);
    if (!to) return { externalId: null, status: 'failed', error: 'Número destino inválido' };

    const form = new URLSearchParams();
    form.set('From', addressFor(this.provider, account.identifier));
    form.set('To', this.provider === 'twilio_whatsapp' ? `whatsapp:${to}` : to);
    if (message.templateKey) {
      form.set('ContentSid', message.templateKey);
      if (message.templateVariables) {
        form.set('ContentVariables', JSON.stringify(message.templateVariables));
      }
    } else if (message.body) {
      form.set('Body', message.body);
    }
    if (message.mediaObjectIds && message.mediaObjectIds.length > 0) {
      const media = await mediaUrlsFor(message.mediaObjectIds);
      if (media.error) return { externalId: null, status: 'failed', error: media.error };
      for (const url of media.urls) form.append('MediaUrl', url);
    }
    if (!form.has('Body') && !form.has('MediaUrl') && !form.has('ContentSid')) {
      return { externalId: null, status: 'failed', error: 'Mensaje vacío' };
    }

    const url = `https://${TWILIO_API_HOST}/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
    try {
      const res = await safeFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: basicAuth(creds),
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: form.toString(),
        },
        { allowedHosts: [TWILIO_API_HOST], timeoutMs: 15_000 }
      );
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
      } catch {
        data = {};
      }
      let result: OutboundResult;
      if (res.status >= 200 && res.status < 300) {
        const price = data.price != null ? Math.abs(Number(data.price)) : undefined;
        result = {
          externalId: typeof data.sid === 'string' ? data.sid : null,
          status: mapOutboundStatus(typeof data.status === 'string' ? data.status : undefined),
          cost: Number.isFinite(price) ? price : undefined,
          providerMeta: {
            status: data.status ?? null,
            numSegments: data.num_segments ?? null,
            errorCode: data.error_code ?? null,
          },
        };
      } else {
        result = {
          externalId: null,
          status: 'failed',
          error:
            typeof data.message === 'string'
              ? `Twilio ${data.code ?? res.status}: ${data.message}`
              : `Twilio respondió ${res.status}`,
          providerMeta: { code: data.code ?? null, httpStatus: res.status },
        };
      }
      this.cache.set(message.idempotencyKey, result);
      return result;
    } catch (err) {
      if (err instanceof EgressError && err.code === 'timeout') {
        return {
          externalId: null,
          status: 'queued',
          uncertain: true,
          error: 'Twilio no confirmó el envío a tiempo; se verificará por webhook',
        };
      }
      return {
        externalId: null,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error de red hacia Twilio',
      };
    }
  }

  async parseWebhook(
    account: CommAccount | null,
    request: { headers: Record<string, string>; rawBody: string; url: string }
  ): Promise<{ messages: InboundMessage[]; deliveries: DeliveryUpdate[] } | null> {
    const signature = request.headers['x-twilio-signature'];
    if (!signature) return null;
    let creds: TwilioCredentials;
    try {
      creds = await resolveTwilioCredentials(account);
    } catch {
      return null;
    }
    const params = parseFormBody(request.rawBody);
    const signedUrl = resolveTwilioWebhookUrl(request.url, undefined, request.headers);
    const expected = computeTwilioSignature(creds.authToken, signedUrl, params);
    if (!timingSafeEqualString(expected, signature)) {
      console.warn('[twilio-webhook] firma inválida', {
        signedUrl,
        baseConfigured: Boolean(process.env.TWILIO_WEBHOOK_BASE_URL),
        accountSid: creds.accountSid,
        credentialLooksLikeApiKey: creds.accountSid.startsWith('SK'),
        authTokenLength: creds.authToken.length,
      });
      return null;
    }

    const messages: InboundMessage[] = [];
    const deliveries: DeliveryUpdate[] = [];
    const sid = first(params.MessageSid) ?? first(params.SmsSid);
    const messageStatus = first(params.MessageStatus);
    if (sid && messageStatus) {
      const status = mapDeliveryStatus(messageStatus);
      if (status) {
        const code = first(params.ErrorCode);
        const detail = first(params.ErrorMessage);
        deliveries.push({
          externalId: sid,
          status,
          error: code ? `${code}${detail ? `: ${detail}` : ''}` : undefined,
          at: new Date(),
        });
      }
      return { messages, deliveries };
    }

    const from = first(params.From);
    if (sid && from) {
      const numMedia = Number(first(params.NumMedia) ?? '0') || 0;
      const media: InboundMessage['media'] = [];
      for (let i = 0; i < numMedia; i++) {
        const url = first(params[`MediaUrl${i}`]);
        if (!url) continue;
        const contentType = first(params[`MediaContentType${i}`]) ?? 'application/octet-stream';
        media.push({
          url,
          contentType,
          fileName: fileNameFromContentType(`media-${i + 1}`, contentType),
        });
      }
      const fromE164 = normalizePhone(from) ?? stripChannelPrefix(from);
      messages.push({
        externalId: sid,
        from: fromE164,
        fromName: first(params.ProfileName) || undefined,
        body: first(params.Body) ?? null,
        media,
        receivedAt: new Date(),
        providerMeta: {
          to: first(params.To) ?? null,
          waId: first(params.WaId) ?? null,
          smsStatus: first(params.SmsStatus) ?? null,
          messagingServiceSid: first(params.MessagingServiceSid) ?? null,
          numSegments: first(params.NumSegments) ?? null,
        },
      });
    }
    return { messages, deliveries };
  }

  async testConnection(account: CommAccount): Promise<{ ok: boolean; detail: string }> {
    let creds: TwilioCredentials;
    try {
      creds = await resolveTwilioCredentials(account);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    try {
      const res = await safeFetch(
        `https://${TWILIO_API_HOST}/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}.json`,
        { method: 'GET', headers: { Authorization: basicAuth(creds), Accept: 'application/json' } },
        { allowedHosts: [TWILIO_API_HOST], timeoutMs: 10_000 }
      );
      if (res.status !== 200) {
        return { ok: false, detail: `Twilio respondió ${res.status} al consultar la cuenta` };
      }
      const data = JSON.parse(res.body.toString('utf8')) as {
        friendly_name?: string;
        status?: string;
      };
      return {
        ok: (data.status ?? 'active') === 'active',
        detail: `Cuenta ${data.friendly_name ?? creds.accountSid} (${data.status ?? 'active'}) · remitente ${addressFor(this.provider, account.identifier)}`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'Error al conectar con Twilio',
      };
    }
  }

  async fetchMedia(
    account: CommAccount,
    media: { url: string; contentType: string; fileName?: string }
  ): Promise<MediaFetchResult> {
    const creds = await resolveTwilioCredentials(account);
    const res = await safeFetch(
      media.url,
      { method: 'GET', headers: { Authorization: basicAuth(creds) } },
      {
        allowedHosts: TWILIO_MEDIA_HOSTS,
        timeoutMs: 30_000,
        maxResponseBytes: INBOUND_MEDIA_MAX_BYTES,
        allowedContentTypes: INBOUND_MEDIA_CONTENT_TYPES,
        maxRedirects: 3,
      }
    );
    if (res.status !== 200)
      throw new Error(`Twilio devolvió ${res.status} al descargar el adjunto`);
    const contentType = res.headers['content-type'] ?? media.contentType;
    return {
      buffer: res.body,
      contentType,
      fileName: media.fileName ?? fileNameFromContentType('media', contentType),
    };
  }
}

export const twilioWhatsAppAdapter: ChannelAdapter = new TwilioAdapter('twilio_whatsapp');
export const twilioSmsAdapter: ChannelAdapter = new TwilioAdapter('twilio_sms');

registerChannelAdapter(twilioWhatsAppAdapter);
registerChannelAdapter(twilioSmsAdapter);
