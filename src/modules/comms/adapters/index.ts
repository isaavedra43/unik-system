/**
 * Registers every channel adapter. Import this module (comms-service and the
 * webhook routes do) before calling `getChannelAdapter`.
 */
import './twilio-adapter';
import './telegram-adapter';

export { getChannelAdapter, listChannelProviders } from '../channel-adapters';
export type { ChannelAdapter, CommProvider } from '../channel-adapters';
export { hasMediaFetcher } from './media';
export type { MediaCapableAdapter, MediaFetchResult } from './media';
export { generateTelegramWebhookSecret, verifyTelegramSecret } from './telegram-adapter';
export { computeTwilioSignature, resolveTwilioWebhookUrl } from './twilio-adapter';

export const PROVIDER_HOSTS: Record<string, string[]> = {
  twilio_whatsapp: ['api.twilio.com'],
  twilio_sms: ['api.twilio.com'],
  telegram: ['api.telegram.org'],
};

export function extensionNamespaceFor(provider: string): string {
  return provider === 'telegram' ? 'comm.telegram' : 'comm.twilio';
}
