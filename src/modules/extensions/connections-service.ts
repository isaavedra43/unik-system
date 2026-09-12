import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { decryptSecret, encryptSecret, isSecretsConfigured, maskSecret } from './secrets';

/**
 * Extension connections (authorized accounts).
 *
 * - Team connections run with an explicit policy set by the administrator.
 * - Personal connections run with the identity of the user who authorized
 *   them and are never used for anyone else.
 * - Secrets are stored encrypted (AES-256-GCM, master key outside PostgreSQL)
 *   with the key id for rotation. They are never returned to the browser.
 */

export interface ConnectionSecret {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  /** OAuth client secret (stored on the "service" connection of an extension). */
  clientSecret?: string;
  tokenType?: string;
}

export interface CreateConnectionInput {
  extensionId: string;
  authType: 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'service';
  scopeType: 'team' | 'personal';
  ownerUserId?: string | null;
  name: string;
  secret: ConnectionSecret;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export function toConnectionDTO(c: {
  id: string;
  extensionId: string;
  authType: string;
  scopeType: string;
  ownerUserId: string | null;
  name: string;
  status: string;
  keyId: string | null;
  expiresAt: Date | null;
  scopes: string[];
  metadata: unknown;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}) {
  return {
    id: c.id,
    extensionId: c.extensionId,
    authType: c.authType,
    scopeType: c.scopeType,
    ownerUserId: c.ownerUserId,
    name: c.name,
    status: c.status,
    keyId: c.keyId,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    scopes: c.scopes,
    metadata: (c.metadata as Record<string, unknown> | null) ?? null,
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    lastError: c.lastError,
    createdAt: c.createdAt.toISOString(),
    hasSecret: true,
  };
}

export async function createConnection(input: CreateConnectionInput) {
  if (!isSecretsConfigured()) {
    throw new ConnectionError(
      'UNIK_SECRETS_MASTER_KEY no está configurada; no se pueden guardar credenciales',
      503
    );
  }
  const enc = encryptSecret(JSON.stringify(input.secret));
  const metadata = {
    ...(input.metadata ?? {}),
    maskedKey: maskSecret(input.secret.apiKey ?? input.secret.accessToken ?? ''),
  };
  if (input.scopeType === 'personal' && !input.ownerUserId) {
    throw new ConnectionError('Una conexión personal requiere propietario', 400);
  }
  return prisma.extensionConnection.create({
    data: {
      extensionId: input.extensionId,
      authType: input.authType,
      scopeType: input.scopeType,
      ownerUserId: input.scopeType === 'personal' ? input.ownerUserId : null,
      name: input.name.slice(0, 120),
      keyId: enc.keyId,
      secretCiphertext: enc.ciphertext,
      scopes: input.scopes ?? [],
      metadata: metadata as Prisma.InputJsonValue,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export async function updateConnectionSecret(
  id: string,
  secret: ConnectionSecret,
  expiresAt?: Date | null
) {
  const enc = encryptSecret(JSON.stringify(secret));
  return prisma.extensionConnection.update({
    where: { id },
    data: {
      keyId: enc.keyId,
      secretCiphertext: enc.ciphertext,
      expiresAt: expiresAt ?? null,
      status: 'active',
      lastError: null,
    },
  });
}

/** Server-side only. Never expose the returned object to the browser or the model. */
export async function readConnectionSecret(connectionId: string): Promise<ConnectionSecret> {
  const c = await prisma.extensionConnection.findUnique({ where: { id: connectionId } });
  if (!c || !c.secretCiphertext || !c.keyId)
    throw new ConnectionError('Conexión sin credenciales', 404);
  if (c.status !== 'active') throw new ConnectionError(`Conexión ${c.status}`, 409);
  return JSON.parse(
    decryptSecret({ keyId: c.keyId, ciphertext: c.secretCiphertext })
  ) as ConnectionSecret;
}

/**
 * Picks the connection a capability must run with:
 * - 'personal': the actor's own active connection (never someone else's).
 * - 'team': the extension's team connection.
 * - 'none': no connection.
 */
export async function resolveConnectionForActor(
  extensionId: string,
  connectionScope: 'none' | 'team' | 'personal',
  actor: CurrentUser
) {
  if (connectionScope === 'none') return null;
  const connection = await prisma.extensionConnection.findFirst({
    where: {
      extensionId,
      status: 'active',
      scopeType: connectionScope,
      ...(connectionScope === 'personal' ? { ownerUserId: actor.id } : {}),
      authType: { not: 'service' },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!connection) {
    throw new ConnectionError(
      connectionScope === 'personal'
        ? 'Conecta tu cuenta para usar esta extensión'
        : 'La extensión no tiene una conexión de equipo activa',
      412
    );
  }
  return connection;
}

export async function listConnections(
  extensionId: string,
  actor: CurrentUser,
  options: { includeTeam: boolean }
) {
  const rows = await prisma.extensionConnection.findMany({
    where: {
      extensionId,
      revokedAt: null,
      OR: [
        { scopeType: 'personal', ownerUserId: actor.id },
        ...(options.includeTeam ? [{ scopeType: 'team' as const }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toConnectionDTO);
}

/** Revoking disconnects immediately; pending proposals bound to it are invalidated. */
export async function revokeConnection(
  id: string,
  actor: CurrentUser,
  options: { allowTeam: boolean }
) {
  const c = await prisma.extensionConnection.findUnique({ where: { id } });
  if (!c) throw new ConnectionError('Conexión no encontrada', 404);
  const isOwner = c.scopeType === 'personal' && c.ownerUserId === actor.id;
  if (!isOwner && !(c.scopeType === 'team' && options.allowTeam) && !actor.isSuperAdmin) {
    throw new ConnectionError('Sin permiso para desconectar esta cuenta', 403);
  }
  await prisma.extensionConnection.update({
    where: { id },
    data: { status: 'revoked', revokedAt: new Date(), secretCiphertext: null },
  });
  await prisma.aiProposal.updateMany({
    where: { connectionId: id, status: 'pending' },
    data: { status: 'invalidated', error: 'La conexión fue revocada' },
  });
}

/** Builds outbound auth headers for a connection. Never logged. */
export function buildAuthHeaders(
  authType: string,
  secret: ConnectionSecret,
  config: { apiKeyHeader?: string; apiKeyPrefix?: string } = {}
): Record<string, string> {
  switch (authType) {
    case 'oauth2':
    case 'bearer':
      return secret.accessToken
        ? { Authorization: `${secret.tokenType ?? 'Bearer'} ${secret.accessToken}` }
        : {};
    case 'api_key':
      return secret.apiKey
        ? { [config.apiKeyHeader ?? 'X-API-Key']: `${config.apiKeyPrefix ?? ''}${secret.apiKey}` }
        : {};
    case 'basic':
      return secret.username
        ? {
            Authorization: `Basic ${Buffer.from(`${secret.username}:${secret.password ?? ''}`).toString('base64')}`,
          }
        : {};
    default:
      return {};
  }
}

/**
 * Runs `fn` while holding a per-connection refresh lock (60s) so concurrent
 * token refreshes never race. Waits briefly for a lock held by another
 * process instead of refreshing twice.
 */
export async function withRefreshLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = new Date();
    const claimed = await prisma.extensionConnection.updateMany({
      where: {
        id: connectionId,
        OR: [{ refreshLockedUntil: null }, { refreshLockedUntil: { lt: now } }],
      },
      data: { refreshLockedUntil: new Date(now.getTime() + 60_000) },
    });
    if (claimed.count === 1) break;
    if (Date.now() > deadline)
      throw new ConnectionError('No se pudo obtener el bloqueo de renovación', 503);
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    await prisma.extensionConnection
      .update({ where: { id: connectionId }, data: { refreshLockedUntil: null } })
      .catch(() => undefined);
  }
}

export async function touchConnection(id: string, error?: string): Promise<void> {
  await prisma.extensionConnection
    .update({
      where: { id },
      data: { lastUsedAt: new Date(), lastError: error ? error.slice(0, 500) : null },
    })
    .catch(() => undefined);
}
