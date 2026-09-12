import { Prisma, type CommAccount } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { createConnection } from '@/modules/extensions/connections-service';
import { assertInboxAdmin, assertInboxUse, visibleAccountsWhere } from './comms-access';
import { CommsError, assertFound } from './comms-errors';
import { normalizePhone } from './normalize';
import {
  PROVIDER_HOSTS,
  extensionNamespaceFor,
  generateTelegramWebhookSecret,
  getChannelAdapter,
} from './adapters';

/**
 * Messaging accounts (numbers / bots) administration. Credentials are stored
 * as team connections of an automatically maintained extension
 * ("comm.twilio" / "comm.telegram", kind api, enabled, egress limited to the
 * provider host) and are never returned to the browser.
 */

export const COMM_PROVIDERS = ['twilio_whatsapp', 'twilio_sms', 'telegram'] as const;

export const accountCredentialsSchema = z.union([
  z.object({ accountSid: z.string().min(10).max(80), authToken: z.string().min(10).max(200) }),
  z.object({ botToken: z.string().min(20).max(200) }),
]);

export const createAccountSchema = z.object({
  provider: z.enum(COMM_PROVIDERS),
  label: z.string().min(2).max(120),
  identifier: z.string().min(2).max(120),
  teamKeys: z.array(z.string().min(1).max(60)).max(50).default([]),
  status: z.enum(['active', 'paused']).default('active'),
  credentials: accountCredentialsSchema.optional(),
  config: z.record(z.unknown()).optional(),
});

export const updateAccountSchema = z.object({
  label: z.string().min(2).max(120).optional(),
  teamKeys: z.array(z.string().min(1).max(60)).max(50).optional(),
  status: z.enum(['active', 'paused']).optional(),
  credentials: accountCredentialsSchema.optional(),
  rotateWebhookSecret: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export interface CommAccountDTO {
  id: string;
  provider: string;
  label: string;
  identifier: string;
  teamKeys: string[];
  status: string;
  hasConnection: boolean;
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
}

function publicBaseUrl(): string {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL || process.env.APP_URL || '';
  return base.replace(/\/+$/, '');
}

export function webhookUrlFor(account: Pick<CommAccount, 'id' | 'provider'>): string {
  const base = publicBaseUrl();
  return account.provider === 'telegram'
    ? `${base}/api/webhooks/telegram/${account.id}`
    : `${base}/api/webhooks/twilio/messaging?accountId=${account.id}`;
}

export function toAccountDTO(account: CommAccount): CommAccountDTO {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    identifier: account.identifier,
    teamKeys: account.teamKeys,
    status: account.status,
    hasConnection: Boolean(account.connectionId),
    webhookUrl: webhookUrlFor(account),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

/** Accounts the user may work with in the inbox. */
export async function listAccountsForUser(user: CurrentUser): Promise<CommAccountDTO[]> {
  assertInboxUse(user);
  const accounts = await prisma.commAccount.findMany({
    where: visibleAccountsWhere(user),
    orderBy: [{ provider: 'asc' }, { label: 'asc' }],
  });
  return accounts.map(toAccountDTO);
}

export async function listAllAccounts(actor: CurrentUser): Promise<CommAccountDTO[]> {
  assertInboxAdmin(actor);
  const accounts = await prisma.commAccount.findMany({
    orderBy: [{ provider: 'asc' }, { label: 'asc' }],
  });
  return accounts.map(toAccountDTO);
}

/** Creates or updates the extension that owns the provider credentials. */
export async function ensureProviderExtension(
  actor: CurrentUser,
  provider: string
): Promise<{ id: string }> {
  const namespace = extensionNamespaceFor(provider);
  const allowedHosts = PROVIDER_HOSTS[provider] ?? [];
  const name = namespace === 'comm.twilio' ? 'Twilio (WhatsApp/SMS)' : 'Telegram Bot API';
  const extension = await prisma.extension.upsert({
    where: { namespace },
    create: {
      namespace,
      kind: 'api',
      name,
      description: 'Canal de mensajería administrado por la bandeja omnicanal',
      createdBy: actor.id,
      status: 'enabled',
      allowedHosts,
      allowedPorts: [443],
      config: { managedBy: 'comms' } as Prisma.InputJsonValue,
    },
    update: { status: 'enabled', allowedHosts, kind: 'api' },
    select: { id: true },
  });
  return extension;
}

async function storeCredentials(
  actor: CurrentUser,
  provider: string,
  label: string,
  credentials: z.infer<typeof accountCredentialsSchema>
): Promise<string> {
  const extension = await ensureProviderExtension(actor, provider);
  if ('botToken' in credentials) {
    if (provider !== 'telegram')
      throw new CommsError('Credenciales no válidas para este proveedor', 400);
    const connection = await createConnection({
      extensionId: extension.id,
      authType: 'api_key',
      scopeType: 'team',
      name: `Telegram · ${label}`,
      secret: { apiKey: credentials.botToken },
      metadata: { provider },
    });
    return connection.id;
  }
  if (provider === 'telegram')
    throw new CommsError('Credenciales no válidas para este proveedor', 400);
  const connection = await createConnection({
    extensionId: extension.id,
    authType: 'basic',
    scopeType: 'team',
    name: `Twilio · ${label}`,
    secret: { username: credentials.accountSid, password: credentials.authToken },
    metadata: { provider, accountSid: credentials.accountSid },
  });
  return connection.id;
}

function normalizeIdentifier(provider: string, identifier: string): string {
  if (provider === 'telegram') return identifier.replace(/^@/, '').trim();
  const phone = normalizePhone(identifier);
  if (!phone) throw new CommsError('El número debe estar en formato E.164 (+52...)', 400);
  return phone;
}

export async function createAccount(
  actor: CurrentUser,
  input: CreateAccountInput
): Promise<{ account: CommAccountDTO; webhookSecret: string | null }> {
  assertInboxAdmin(actor);
  const identifier = normalizeIdentifier(input.provider, input.identifier);
  const existing = await prisma.commAccount.findUnique({
    where: { provider_identifier: { provider: input.provider, identifier } },
    select: { id: true },
  });
  if (existing) throw new CommsError('Ya existe una cuenta con ese identificador', 409);

  const connectionId = input.credentials
    ? await storeCredentials(actor, input.provider, input.label, input.credentials)
    : null;
  const telegramSecret = input.provider === 'telegram' ? generateTelegramWebhookSecret() : null;
  const account = await prisma.commAccount.create({
    data: {
      provider: input.provider,
      label: input.label,
      identifier,
      connectionId,
      teamKeys: [...new Set(input.teamKeys)],
      status: input.status,
      webhookSecret: telegramSecret?.hash ?? null,
      config: (input.config ?? {}) as Prisma.InputJsonValue,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.account.created',
    targetType: 'comm_account',
    targetId: account.id,
    metadata: {
      provider: account.provider,
      identifier: account.identifier,
      teamKeys: account.teamKeys,
    },
  });
  return { account: toAccountDTO(account), webhookSecret: telegramSecret?.secret ?? null };
}

export async function updateAccount(
  actor: CurrentUser,
  id: string,
  patch: UpdateAccountInput
): Promise<{ account: CommAccountDTO; webhookSecret: string | null }> {
  assertInboxAdmin(actor);
  const account = assertFound(
    await prisma.commAccount.findUnique({ where: { id } }),
    'Cuenta no encontrada'
  );
  const data: Prisma.CommAccountUpdateInput = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.teamKeys !== undefined) data.teamKeys = [...new Set(patch.teamKeys)];
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.config !== undefined) data.config = patch.config as Prisma.InputJsonValue;
  if (patch.credentials) {
    const connectionId = await storeCredentials(
      actor,
      account.provider,
      patch.label ?? account.label,
      patch.credentials
    );
    data.connectionId = connectionId;
    if (account.connectionId) {
      await prisma.extensionConnection
        .update({
          where: { id: account.connectionId },
          data: { status: 'revoked', revokedAt: new Date() },
        })
        .catch(() => undefined);
    }
  }
  let webhookSecret: string | null = null;
  if (patch.rotateWebhookSecret && account.provider === 'telegram') {
    const generated = generateTelegramWebhookSecret();
    data.webhookSecret = generated.hash;
    webhookSecret = generated.secret;
  }
  const updated = await prisma.commAccount.update({ where: { id }, data });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.account.updated',
    targetType: 'comm_account',
    targetId: id,
    metadata: {
      fields: Object.keys(patch).filter((k) => k !== 'credentials'),
      credentialsRotated: Boolean(patch.credentials),
      webhookSecretRotated: Boolean(webhookSecret),
    },
  });
  return { account: toAccountDTO(updated), webhookSecret };
}

export async function deleteAccount(actor: CurrentUser, id: string): Promise<void> {
  assertInboxAdmin(actor);
  const account = assertFound(
    await prisma.commAccount.findUnique({ where: { id } }),
    'Cuenta no encontrada'
  );
  const messages = await prisma.commMessage.count({ where: { accountId: id } });
  if (messages > 0) {
    throw new CommsError('La cuenta tiene historial; pausa la cuenta en lugar de eliminarla', 409);
  }
  await prisma.commAccount.delete({ where: { id } });
  if (account.connectionId) {
    await prisma.extensionConnection
      .update({
        where: { id: account.connectionId },
        data: { status: 'revoked', revokedAt: new Date() },
      })
      .catch(() => undefined);
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.account.deleted',
    targetType: 'comm_account',
    targetId: id,
    metadata: { provider: account.provider, identifier: account.identifier },
  });
}

export async function testAccount(
  actor: CurrentUser,
  id: string
): Promise<{ ok: boolean; detail: string }> {
  assertInboxAdmin(actor);
  const account = assertFound(
    await prisma.commAccount.findUnique({ where: { id } }),
    'Cuenta no encontrada'
  );
  const result = await getChannelAdapter(account.provider).testConnection(account);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.account.tested',
    targetType: 'comm_account',
    targetId: id,
    metadata: { ok: result.ok },
  });
  return result;
}

/** Resolves the account a Twilio webhook belongs to (query accountId or the "To" address). */
export async function findAccountForTwilioWebhook(
  accountId: string | null,
  to: string | null
): Promise<CommAccount | null> {
  if (accountId) {
    const byId = await prisma.commAccount.findUnique({ where: { id: accountId } });
    if (byId && byId.provider !== 'telegram') return byId;
  }
  if (!to) return null;
  const provider = to.toLowerCase().startsWith('whatsapp:') ? 'twilio_whatsapp' : 'twilio_sms';
  const identifier = normalizePhone(to);
  if (!identifier) return null;
  return prisma.commAccount.findUnique({
    where: { provider_identifier: { provider, identifier } },
  });
}
