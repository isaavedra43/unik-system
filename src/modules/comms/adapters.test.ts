import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CommAccount } from '@prisma/client';

/**
 * Webhook authentication: Twilio request signatures and Telegram secret
 * tokens. No network, no database: adapters only parse and verify here.
 */

vi.mock('@/modules/extensions/connections-service', () => ({
  readConnectionSecret: vi.fn(async () => ({})),
}));
vi.mock('@/modules/storage/storage-service', () => ({
  authorizeDownload: vi.fn(),
  getStorageObject: vi.fn(),
  readObjectToBuffer: vi.fn(),
}));

import {
  computeTwilioSignature,
  resolveTwilioWebhookUrl,
  twilioWhatsAppAdapter,
} from './adapters/twilio-adapter';
import {
  generateTelegramWebhookSecret,
  telegramAdapter,
  verifyTelegramSecret,
} from './adapters/telegram-adapter';
import { sha256Hex } from './normalize';

const AUTH_TOKEN = '12345678901234567890abcdef';

function account(overrides: Partial<CommAccount> = {}): CommAccount {
  return {
    id: 'acc1',
    provider: 'twilio_whatsapp',
    label: 'Ventas',
    identifier: '+5218112345678',
    connectionId: null,
    teamKeys: ['ventas'],
    status: 'active',
    webhookSecret: null,
    config: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('Twilio signature', () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://unik.example.com';
  });

  it('matches the documented algorithm (sorted params appended to the URL)', () => {
    // Example from Twilio's security docs.
    const signature = computeTwilioSignature(
      '12345',
      'https://mycompany.com/myapp.php?foo=1&bar=2',
      {
        CallSid: 'CA1234567890ABCDE',
        Caller: '+14158675309',
        Digits: '1234',
        From: '+14158675309',
        To: '+18005551212',
      }
    );
    expect(signature).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  });

  it('resolves the public URL from the configured base and the request path', () => {
    expect(
      resolveTwilioWebhookUrl('http://localhost:3000/api/webhooks/twilio/messaging?accountId=acc1')
    ).toBe('https://unik.example.com/api/webhooks/twilio/messaging?accountId=acc1');
  });

  it('accepts a valid signature and extracts the inbound message with media', async () => {
    const url = 'https://unik.example.com/api/webhooks/twilio/messaging?accountId=acc1';
    const params = {
      MessageSid: 'SM123',
      From: 'whatsapp:+5218199999999',
      To: 'whatsapp:+5218112345678',
      Body: 'Hola, quiero una cotización',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/SM123/Media/ME1',
      MediaContentType0: 'image/jpeg',
      ProfileName: 'Ana',
      SmsStatus: 'received',
    };
    const rawBody = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
    const result = await twilioWhatsAppAdapter.parseWebhook(account(), {
      headers: { 'x-twilio-signature': signature },
      rawBody,
      url: 'http://localhost:3000/api/webhooks/twilio/messaging?accountId=acc1',
    });
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0]).toMatchObject({
      externalId: 'SM123',
      from: '+5218199999999',
      fromName: 'Ana',
      body: 'Hola, quiero una cotización',
    });
    expect(result!.messages[0].media[0]).toMatchObject({ contentType: 'image/jpeg' });
    expect(result!.deliveries).toHaveLength(0);
  });

  it('rejects a tampered body or a missing signature', async () => {
    const url = 'https://unik.example.com/api/webhooks/twilio/messaging?accountId=acc1';
    const params = { MessageSid: 'SM123', From: 'whatsapp:+5218199999999', Body: 'Hola' };
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
    const tampered = new URLSearchParams({ ...params, Body: 'Hola!' }).toString();
    expect(
      await twilioWhatsAppAdapter.parseWebhook(account(), {
        headers: { 'x-twilio-signature': signature },
        rawBody: tampered,
        url,
      })
    ).toBeNull();
    expect(
      await twilioWhatsAppAdapter.parseWebhook(account(), {
        headers: {},
        rawBody: new URLSearchParams(params).toString(),
        url,
      })
    ).toBeNull();
  });

  it('parses status callbacks as delivery updates', async () => {
    const url = 'https://unik.example.com/api/webhooks/twilio/messaging?accountId=acc1';
    const params = {
      MessageSid: 'SM999',
      MessageStatus: 'delivered',
      To: 'whatsapp:+5218199999999',
      From: 'whatsapp:+5218112345678',
    };
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
    const result = await twilioWhatsAppAdapter.parseWebhook(account(), {
      headers: { 'x-twilio-signature': signature },
      rawBody: new URLSearchParams(params).toString(),
      url,
    });
    expect(result!.messages).toHaveLength(0);
    expect(result!.deliveries[0]).toMatchObject({ externalId: 'SM999', status: 'delivered' });
  });
});

describe('Telegram secret token', () => {
  it('verifies the header against the stored sha256 in constant time', () => {
    const { secret, hash } = generateTelegramWebhookSecret();
    expect(hash).toBe(sha256Hex(secret));
    expect(verifyTelegramSecret(secret, hash)).toBe(true);
    expect(verifyTelegramSecret(`${secret}x`, hash)).toBe(false);
    expect(verifyTelegramSecret(undefined, hash)).toBe(false);
    expect(verifyTelegramSecret(secret, null)).toBe(false);
  });

  it('parses an update only when the secret matches, using chat-scoped external ids', async () => {
    const { secret, hash } = generateTelegramWebhookSecret();
    const acc = account({ provider: 'telegram', identifier: 'unik_bot', webhookSecret: hash });
    const update = {
      update_id: 77,
      message: {
        message_id: 5,
        date: 1_700_000_000,
        chat: { id: 123456, type: 'private' },
        from: { id: 123456, first_name: 'Luis', last_name: 'Pérez', username: 'luisp' },
        text: 'Buenas tardes',
        photo: [{ file_id: 'small' }, { file_id: 'big' }],
      },
    };
    const ok = await telegramAdapter.parseWebhook(acc, {
      headers: { 'x-telegram-bot-api-secret-token': secret },
      rawBody: JSON.stringify(update),
      url: 'https://unik.example.com/api/webhooks/telegram/acc1',
    });
    expect(ok!.messages[0]).toMatchObject({
      externalId: '123456:5',
      from: '123456',
      fromName: 'Luis Pérez',
      body: 'Buenas tardes',
    });
    expect(ok!.messages[0].media[0].url).toBe('tg://file/big');

    const bad = await telegramAdapter.parseWebhook(acc, {
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      rawBody: JSON.stringify(update),
      url: 'https://unik.example.com/api/webhooks/telegram/acc1',
    });
    expect(bad).toBeNull();
  });
});
