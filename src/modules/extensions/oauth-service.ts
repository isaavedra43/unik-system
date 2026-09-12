import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { safeFetch, type EgressPolicy } from './safe-fetch';
import {
  ConnectionError,
  createConnection,
  readConnectionSecret,
  updateConnectionSecret,
  withRefreshLock,
  type ConnectionSecret,
} from './connections-service';
import { safeEqual } from './secrets';

/**
 * OAuth 2.0 authorization code flow with `state` and PKCE for extension
 * connections. The client secret (when the provider requires one) lives in a
 * "service" connection of the extension, encrypted like any other secret.
 * Tokens are exchanged and refreshed through the common egress layer; UNIK
 * never forwards its own session tokens to external services.
 */

export interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Extra authorization params (e.g. access_type=offline). */
  extraAuthParams?: Record<string, string>;
  /** Some providers want client credentials in the body instead of Basic auth. */
  clientAuth?: 'basic' | 'body';
}

const STATE_TTL_MS = 10 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function getOAuthRedirectUri(): string {
  const base = (process.env.APP_URL ?? '').replace(/\/$/, '');
  if (!base) throw new ConnectionError('APP_URL es requerido para OAuth', 500);
  return `${base}/app/assistant/api/extensions/oauth/callback`;
}

async function loadProviderConfig(
  extensionId: string
): Promise<{ config: OAuthProviderConfig; policy: EgressPolicy; clientSecret: string | null }> {
  const extension = await prisma.extension.findUnique({ where: { id: extensionId } });
  if (!extension) throw new ConnectionError('Extensión no encontrada', 404);
  const cfg = ((extension.config as Record<string, unknown> | null) ?? {}).oauth as
    OAuthProviderConfig | undefined;
  if (!cfg?.authorizationUrl || !cfg.tokenUrl || !cfg.clientId) {
    throw new ConnectionError('La extensión no tiene OAuth configurado', 400);
  }
  const policy: EgressPolicy = {
    allowedHosts: extension.allowedHosts,
    allowedPorts: extension.allowedPorts,
    timeoutMs: 15_000,
  };
  const service = await prisma.extensionConnection.findFirst({
    where: { extensionId, authType: 'service', status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  let clientSecret: string | null = null;
  if (service) {
    const secret = await readConnectionSecret(service.id);
    clientSecret = secret.clientSecret ?? null;
  }
  return { config: cfg, policy, clientSecret };
}

/** Step 1: builds the provider URL and persists state + PKCE verifier. */
export async function beginOAuth(
  actor: CurrentUser,
  extensionId: string,
  scopeType: 'personal' | 'team'
): Promise<{ url: string }> {
  const { config, policy } = await loadProviderConfig(extensionId);
  const authUrl = new URL(config.authorizationUrl);
  if (authUrl.protocol !== 'https:')
    throw new ConnectionError('La URL de autorización debe ser HTTPS', 400);
  const { isHostAllowed } = await import('./safe-fetch');
  if (!isHostAllowed(authUrl.hostname, policy.allowedHosts)) {
    throw new ConnectionError('El dominio de autorización no está aprobado para la extensión', 400);
  }
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const redirectUri = getOAuthRedirectUri();
  await prisma.oAuthState.create({
    data: {
      state,
      codeVerifier,
      userId: actor.id,
      extensionId,
      scopeType,
      redirectUri,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', config.scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) authUrl.searchParams.set(k, v);
  return { url: authUrl.toString() };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function exchange(
  tokenUrl: string,
  policy: EgressPolicy,
  clientId: string,
  clientSecret: string | null,
  clientAuth: 'basic' | 'body' | undefined,
  params: Record<string, string>
): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: clientId });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (clientSecret) {
    if (clientAuth === 'body') body.set('client_secret', clientSecret);
    else
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  const res = await safeFetch(tokenUrl, { method: 'POST', headers, body: body.toString() }, policy);
  if (res.status < 200 || res.status >= 300) {
    throw new ConnectionError(
      `El proveedor rechazó el intercambio de token (HTTP ${res.status})`,
      502
    );
  }
  const json = JSON.parse(res.body.toString('utf8')) as TokenResponse;
  if (!json.access_token) throw new ConnectionError('Respuesta de token inválida', 502);
  return json;
}

/** Step 2: callback. Verifies state (user, expiry), exchanges the code with PKCE and stores the tokens. */
export async function completeOAuth(
  actor: CurrentUser,
  code: string,
  state: string
): Promise<{ connectionId: string; extensionId: string }> {
  const row = await prisma.oAuthState.findUnique({ where: { state } });
  if (!row || !safeEqual(row.state, state)) throw new ConnectionError('Estado OAuth inválido', 400);
  await prisma.oAuthState.delete({ where: { id: row.id } }).catch(() => undefined);
  if (row.userId !== actor.id)
    throw new ConnectionError('El flujo OAuth pertenece a otro usuario', 403);
  if (row.expiresAt.getTime() < Date.now()) throw new ConnectionError('El flujo OAuth expiró', 410);

  const { config, policy, clientSecret } = await loadProviderConfig(row.extensionId);
  const token = await exchange(
    config.tokenUrl,
    policy,
    config.clientId,
    clientSecret,
    config.clientAuth,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: row.redirectUri,
      code_verifier: row.codeVerifier,
    }
  );
  const secret: ConnectionSecret = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type ?? 'Bearer',
  };
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
  const existing = await prisma.extensionConnection.findFirst({
    where: {
      extensionId: row.extensionId,
      authType: 'oauth2',
      scopeType: row.scopeType,
      ...(row.scopeType === 'personal' ? { ownerUserId: actor.id } : {}),
      revokedAt: null,
    },
  });
  if (existing) {
    await updateConnectionSecret(existing.id, secret, expiresAt);
    return { connectionId: existing.id, extensionId: row.extensionId };
  }
  const created = await createConnection({
    extensionId: row.extensionId,
    authType: 'oauth2',
    scopeType: row.scopeType as 'team' | 'personal',
    ownerUserId: actor.id,
    name: row.scopeType === 'personal' ? `Cuenta de ${actor.name}` : 'Cuenta de equipo',
    secret,
    scopes: token.scope ? token.scope.split(' ') : config.scopes,
    expiresAt,
  });
  return { connectionId: created.id, extensionId: row.extensionId };
}

/** Returns a valid access token, refreshing under the per-connection lock when expired. */
export async function getValidAccessToken(connectionId: string): Promise<ConnectionSecret> {
  const c = await prisma.extensionConnection.findUnique({ where: { id: connectionId } });
  if (!c) throw new ConnectionError('Conexión no encontrada', 404);
  const secret = await readConnectionSecret(connectionId);
  const expiresSoon = c.expiresAt ? c.expiresAt.getTime() - Date.now() < 60_000 : false;
  if (!expiresSoon || !secret.refreshToken) return secret;

  return withRefreshLock(connectionId, async () => {
    const fresh = await prisma.extensionConnection.findUnique({ where: { id: connectionId } });
    if (fresh?.expiresAt && fresh.expiresAt.getTime() - Date.now() >= 60_000) {
      return readConnectionSecret(connectionId);
    }
    const { config, policy, clientSecret } = await loadProviderConfig(c.extensionId);
    try {
      const token = await exchange(
        config.tokenUrl,
        policy,
        config.clientId,
        clientSecret,
        config.clientAuth,
        {
          grant_type: 'refresh_token',
          refresh_token: secret.refreshToken!,
        }
      );
      const next: ConnectionSecret = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? secret.refreshToken,
        tokenType: token.token_type ?? secret.tokenType ?? 'Bearer',
      };
      await updateConnectionSecret(
        connectionId,
        next,
        token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null
      );
      return next;
    } catch (err) {
      await prisma.extensionConnection.update({
        where: { id: connectionId },
        data: {
          status: 'error',
          lastError: err instanceof Error ? err.message.slice(0, 500) : 'refresh failed',
        },
      });
      throw err;
    }
  });
}

export async function purgeExpiredOAuthStates(now: Date = new Date()): Promise<number> {
  const res = await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
  return res.count;
}
