import { randomBytes } from 'crypto';
import type { CommAccount } from '@prisma/client';
import { readConnectionSecret } from '@/modules/extensions/connections-service';
import { EgressError, safeFetch } from '@/modules/extensions/safe-fetch';
import { getStorageObject, readObjectToBuffer } from '@/modules/storage/storage-service';
import {
  registerChannelAdapter,
  type ChannelAdapter,
  type DeliveryUpdate,
  type InboundMessage,
  type OutboundMessage,
  type OutboundResult,
} from '../channel-adapters';
import { sha256Hex, timingSafeEqualString } from '../normalize';
import {
  fileNameFromContentType,
  INBOUND_MEDIA_CONTENT_TYPES,
  INBOUND_MEDIA_MAX_BYTES,
  SendIdempotencyCache,
  type MediaCapableAdapter,
  type MediaFetchResult,
} from './media';

/**
 * Telegram Bot API adapter.
 *
 * - Outbound: sendMessage / sendPhoto / sendDocument. Media bytes are read
 *   from the object storage and uploaded as multipart (works with every
 *   storage driver, no public URL needed).
 * - Inbound: webhook authenticated with X-Telegram-Bot-Api-Secret-Token
 *   against the sha256 stored in CommAccount.webhookSecret (constant-time).
 *   External ids are "<chatId>:<messageId>" because Telegram message ids are
 *   only unique per chat. Media file ids are resolved lazily (getFile) by
 *   the inbound job so the webhook answers immediately.
 * - Token from the encrypted connection (apiKey) or TELEGRAM_BOT_TOKEN.
 */

export const TELEGRAM_API_HOST = 'api.telegram.org';
const TELEGRAM_FILE_SCHEME = 'tg://file/';
const CAPTION_MAX = 1024;

export async function resolveTelegramToken(account: Pick<CommAccount, 'connectionId'> | null): Promise<string> {
  if (account?.connectionId) {
    const secret = await readConnectionSecret(account.connectionId);
    if (secret.apiKey) return secret.apiKey;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('Telegram no está configurado (conexión cifrada o TELEGRAM_BOT_TOKEN)');
  return token;
}

/** Generates the webhook secret shown once to the administrator; the account stores its sha256. */
export function generateTelegramWebhookSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: sha256Hex(secret) };
}

export function verifyTelegramSecret(header: string | undefined, storedHash: string | null | undefined): boolean {
  if (!header || !storedHash) return false;
  return timingSafeEqualString(sha256Hex(header), storedHash);
}

function redactToken(message: string, token: string): string {
  return token ? message.split(token).join('***') : message;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function telegramCall<T>(
  token: string,
  method: string,
  init: { json?: Record<string, unknown>; multipart?: { body: Buffer; boundary: string } },
  timeoutMs = 15_000
): Promise<TelegramResponse<T>> {
  const url = `https://${TELEGRAM_API_HOST}/bot${token}/${method}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | Buffer | null = null;
  if (init.multipart) {
    headers['Content-Type'] = `multipart/form-data; boundary=${init.multipart.boundary}`;
    body = init.multipart.body;
  } else if (init.json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  try {
    const res = await safeFetch(
      url,
      { method: body === null ? 'GET' : 'POST', headers, body },
      { allowedHosts: [TELEGRAM_API_HOST], timeoutMs }
    );
    try {
      return JSON.parse(res.body.toString('utf8')) as TelegramResponse<T>;
    } catch {
      return { ok: false, description: `Respuesta no válida de Telegram (${res.status})` };
    }
  } catch (err) {
    if (err instanceof EgressError) {
      throw new EgressError(redactToken(err.message, token), err.code);
    }
    throw new Error(redactToken(err instanceof Error ? err.message : 'Error de red', token));
  }
}

function buildMultipart(
  fields: Record<string, string>,
  file: { field: string; fileName: string; contentType: string; buffer: Buffer }
): { body: Buffer; boundary: string } {
  const boundary = `----unik${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8'
      )
    );
  }
  const safeName = file.fileName.replace(/["\r\n]/g, '_');
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8'
    )
  );
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), boundary };
}

interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number | string; type?: string; title?: string; username?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string; file_name?: string };
  video?: { file_id: string; mime_type?: string; file_name?: string };
  sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean };
}

export function externalIdFor(chatId: string | number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

class TelegramAdapter implements MediaCapableAdapter {
  readonly provider = 'telegram' as const;
  private readonly cache = new SendIdempotencyCache<OutboundResult>();

  async send(account: CommAccount, message: OutboundMessage): Promise<OutboundResult> {
    const cached = this.cache.get(message.idempotencyKey);
    if (cached) return cached;
    let token: string;
    try {
      token = await resolveTelegramToken(account);
    } catch (err) {
      return { externalId: null, status: 'failed', error: (err as Error).message };
    }
    const chatId = message.to.trim();
    if (!chatId) return { externalId: null, status: 'failed', error: 'Chat destino inválido' };

    try {
      let lastId: string | null = null;
      let remainingBody = message.body ?? '';
      const mediaIds = message.mediaObjectIds ?? [];
      for (let i = 0; i < mediaIds.length; i++) {
        const object = await getStorageObject(mediaIds[i]);
        if (!object || object.status !== 'ready') {
          return { externalId: null, status: 'failed', error: 'Adjunto no disponible' };
        }
        const buffer = await readObjectToBuffer(object, INBOUND_MEDIA_MAX_BYTES);
        const contentType = object.detectedMimeType ?? object.declaredMimeType;
        const isPhoto = /^image\/(jpeg|png|webp|gif)$/i.test(contentType);
        const fields: Record<string, string> = { chat_id: chatId };
        if (i === 0 && remainingBody && remainingBody.length <= CAPTION_MAX) {
          fields.caption = remainingBody;
          remainingBody = '';
        }
        const multipart = buildMultipart(fields, {
          field: isPhoto ? 'photo' : 'document',
          fileName: object.originalName,
          contentType,
          buffer,
        });
        const res = await telegramCall<TelegramMessage>(
          token,
          isPhoto ? 'sendPhoto' : 'sendDocument',
          { multipart },
          60_000
        );
        if (!res.ok || !res.result) {
          const result: OutboundResult = {
            externalId: lastId,
            status: 'failed',
            error: `Telegram: ${res.description ?? 'error al enviar adjunto'}`,
          };
          return result;
        }
        lastId = externalIdFor(chatId, res.result.message_id);
      }
      if (remainingBody) {
        const res = await telegramCall<TelegramMessage>(token, 'sendMessage', {
          json: { chat_id: chatId, text: remainingBody },
        });
        if (!res.ok || !res.result) {
          return {
            externalId: lastId,
            status: 'failed',
            error: `Telegram: ${res.description ?? 'error al enviar'}`,
            providerMeta: { errorCode: res.error_code ?? null },
          };
        }
        lastId = externalIdFor(chatId, res.result.message_id);
      }
      if (!lastId) return { externalId: null, status: 'failed', error: 'Mensaje vacío' };
      const result: OutboundResult = { externalId: lastId, status: 'sent', cost: 0 };
      this.cache.set(message.idempotencyKey, result);
      return result;
    } catch (err) {
      if (err instanceof EgressError && err.code === 'timeout') {
        return {
          externalId: null,
          status: 'queued',
          uncertain: true,
          error: 'Telegram no confirmó el envío a tiempo',
        };
      }
      return {
        externalId: null,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error de red hacia Telegram',
      };
    }
  }

  async parseWebhook(
    account: CommAccount | null,
    request: { headers: Record<string, string>; rawBody: string; url: string }
  ): Promise<{ messages: InboundMessage[]; deliveries: DeliveryUpdate[] } | null> {
    if (!account) return null;
    if (!verifyTelegramSecret(request.headers['x-telegram-bot-api-secret-token'], account.webhookSecret)) {
      return null;
    }
    let update: { update_id?: number; message?: TelegramMessage; edited_message?: TelegramMessage };
    try {
      update = JSON.parse(request.rawBody) as typeof update;
    } catch {
      return null;
    }
    const msg = update.message;
    if (!msg || !msg.chat) return { messages: [], deliveries: [] };

    const media: InboundMessage['media'] = [];
    if (msg.photo && msg.photo.length > 0) {
      const best = msg.photo[msg.photo.length - 1];
      media.push({ url: `${TELEGRAM_FILE_SCHEME}${best.file_id}`, contentType: 'image/jpeg', fileName: 'foto.jpg' });
    }
    if (msg.document) {
      const contentType = msg.document.mime_type ?? 'application/octet-stream';
      media.push({
        url: `${TELEGRAM_FILE_SCHEME}${msg.document.file_id}`,
        contentType,
        fileName: msg.document.file_name ?? fileNameFromContentType('documento', contentType),
      });
    }
    if (msg.voice) {
      media.push({ url: `${TELEGRAM_FILE_SCHEME}${msg.voice.file_id}`, contentType: msg.voice.mime_type ?? 'audio/ogg', fileName: 'nota-de-voz.ogg' });
    }
    if (msg.audio) {
      const contentType = msg.audio.mime_type ?? 'audio/mpeg';
      media.push({ url: `${TELEGRAM_FILE_SCHEME}${msg.audio.file_id}`, contentType, fileName: msg.audio.file_name ?? fileNameFromContentType('audio', contentType) });
    }
    if (msg.video) {
      const contentType = msg.video.mime_type ?? 'video/mp4';
      media.push({ url: `${TELEGRAM_FILE_SCHEME}${msg.video.file_id}`, contentType, fileName: msg.video.file_name ?? fileNameFromContentType('video', contentType) });
    }
    const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.chat.title || msg.from?.username;
    const chatId = String(msg.chat.id);
    return {
      deliveries: [],
      messages: [
        {
          externalId: externalIdFor(chatId, msg.message_id),
          from: chatId,
          fromName: fromName || undefined,
          body: msg.text ?? msg.caption ?? null,
          media,
          receivedAt: msg.date ? new Date(msg.date * 1000) : new Date(),
          providerMeta: {
            updateId: update.update_id ?? null,
            chatId,
            chatType: msg.chat.type ?? null,
            username: msg.from?.username ?? msg.chat.username ?? null,
            telegramUserId: msg.from?.id ?? null,
            sticker: msg.sticker ? true : undefined,
          },
        },
      ],
    };
  }

  async testConnection(account: CommAccount): Promise<{ ok: boolean; detail: string }> {
    let token: string;
    try {
      token = await resolveTelegramToken(account);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    try {
      const me = await telegramCall<{ username?: string; first_name?: string }>(token, 'getMe', {});
      if (!me.ok || !me.result) return { ok: false, detail: `Telegram: ${me.description ?? 'token inválido'}` };
      const info = await telegramCall<{ url?: string; pending_update_count?: number; last_error_message?: string }>(
        token,
        'getWebhookInfo',
        {}
      );
      const webhook = info.ok && info.result?.url ? `webhook: ${info.result.url}` : 'webhook sin configurar';
      const lastError = info.result?.last_error_message ? ` · último error: ${info.result.last_error_message}` : '';
      return { ok: true, detail: `Bot @${me.result.username ?? me.result.first_name} · ${webhook}${lastError}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Error al conectar con Telegram' };
    }
  }

  async fetchMedia(
    account: CommAccount,
    media: { url: string; contentType: string; fileName?: string }
  ): Promise<MediaFetchResult> {
    const token = await resolveTelegramToken(account);
    if (!media.url.startsWith(TELEGRAM_FILE_SCHEME)) throw new Error('Referencia de archivo Telegram inválida');
    const fileId = media.url.slice(TELEGRAM_FILE_SCHEME.length);
    const file = await telegramCall<{ file_path?: string; file_size?: number }>(token, 'getFile', {
      json: { file_id: fileId },
    });
    if (!file.ok || !file.result?.file_path) throw new Error(`Telegram: ${file.description ?? 'archivo no disponible'}`);
    if (file.result.file_size && file.result.file_size > INBOUND_MEDIA_MAX_BYTES) {
      throw new Error('El archivo excede el tamaño máximo permitido');
    }
    const url = `https://${TELEGRAM_API_HOST}/file/bot${token}/${file.result.file_path}`;
    let res;
    try {
      res = await safeFetch(
        url,
        { method: 'GET' },
        {
          allowedHosts: [TELEGRAM_API_HOST],
          timeoutMs: 30_000,
          maxResponseBytes: INBOUND_MEDIA_MAX_BYTES,
          allowedContentTypes: INBOUND_MEDIA_CONTENT_TYPES,
        }
      );
    } catch (err) {
      throw new Error(redactToken(err instanceof Error ? err.message : 'Error de red', token));
    }
    if (res.status !== 200) throw new Error(`Telegram devolvió ${res.status} al descargar el archivo`);
    const contentType = (res.headers['content-type'] && res.headers['content-type'] !== 'application/octet-stream'
      ? res.headers['content-type']
      : media.contentType) ?? media.contentType;
    return {
      buffer: res.body,
      contentType,
      fileName: media.fileName ?? fileNameFromContentType('archivo', contentType),
    };
  }
}

export const telegramAdapter: ChannelAdapter = new TelegramAdapter();
registerChannelAdapter(telegramAdapter);
