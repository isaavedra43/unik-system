import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  buildSignedWebhookUrl,
  computeTwilioSignature,
  formParamsToRecord,
  verifyTwilioSignature,
} from './twilio-signature';

describe('Twilio signature', () => {
  const token = 'auth-token-secret';
  const url = 'https://unik.example.com/api/webhooks/voice/twilio';
  const params = { CallSid: 'CA123', From: '+5215500000000', To: '+5215511111111' };

  it('matches the documented algorithm (url + sorted key/value pairs, HMAC-SHA1 base64)', () => {
    const expected = createHmac('sha1', token)
      .update(url + 'CallSid' + 'CA123' + 'From' + '+5215500000000' + 'To' + '+5215511111111')
      .digest('base64');
    expect(computeTwilioSignature(token, url, params)).toBe(expected);
    expect(verifyTwilioSignature(token, url, params, expected)).toBe(true);
  });

  it('rejects a tampered body, a wrong token, a wrong URL and a missing header', () => {
    const sig = computeTwilioSignature(token, url, params);
    expect(verifyTwilioSignature(token, url, { ...params, From: '+5215599999999' }, sig)).toBe(
      false
    );
    expect(verifyTwilioSignature('other', url, params, sig)).toBe(false);
    expect(verifyTwilioSignature(token, `${url}?x=1`, params, sig)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, null)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, 'short')).toBe(false);
  });

  it('builds the signed URL from the configured base, never from Host headers', () => {
    expect(
      buildSignedWebhookUrl('https://unik.example.com/', '/api/webhooks/voice/twilio', '')
    ).toBe(url);
    expect(
      buildSignedWebhookUrl('https://unik.example.com', '/api/webhooks/voice/twilio', '?a=1')
    ).toBe(`${url}?a=1`);
  });

  it('converts form params to a record', () => {
    const form = new URLSearchParams('CallSid=CA1&From=%2B521&To=%2B522');
    expect(formParamsToRecord(form)).toEqual({ CallSid: 'CA1', From: '+521', To: '+522' });
  });
});
