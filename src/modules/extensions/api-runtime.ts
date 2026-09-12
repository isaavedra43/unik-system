import type { CurrentUser } from '@/modules/auth/authorization';
import { safeFetch, EgressError, type EgressPolicy } from './safe-fetch';
import {
  buildAuthHeaders,
  resolveConnectionForActor,
  readConnectionSecret,
  touchConnection,
  type ConnectionSecret,
} from './connections-service';
import { getValidAccessToken } from './oauth-service';
import { selectResponseFields } from './openapi-importer';
import { redactDeep } from './secrets';
import type { JsonSchema } from './json-schema-to-zod';

/**
 * Runtime for custom API extensions.
 *
 * The model never gets a generic "call any URL" tool. Each approved
 * OPERATION (method + path template + typed params + body schema + response
 * field selection) becomes its own tool. Every request leaves through the
 * common egress layer with the extension's host/port policy, timeout and
 * response limits, and with the connection identity resolved for the actor.
 */

export interface ApiOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  pathParams?: JsonSchema;
  queryParams?: JsonSchema;
  bodySchema?: JsonSchema | null;
  bodyContentType?: string | null;
  responseFields?: string[];
  /** Static headers approved by the admin (never secrets). */
  headers?: Record<string, string>;
  /** Fixture responses for controlled tests, keyed by a label. */
  fixtures?: Record<string, unknown>;
  retry?: { attempts: number; backoffMs: number };
  idempotent?: boolean;
}

export interface ApiExtensionConfig {
  baseUrl: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ApiExecutionInput {
  extension: { id: string; allowedHosts: string[]; allowedPorts: number[]; config: unknown };
  capability: {
    id: string;
    localName: string;
    connectionScope: string;
    timeoutMs: number;
    maxResultBytes: number;
  };
  operation: ApiOperation;
  args: Record<string, unknown>;
  actor: CurrentUser;
  /** Controlled test: use a fixture instead of the network. */
  fixture?: string;
}

export class ApiRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly uncertain = false
  ) {
    super(message);
    this.name = 'ApiRuntimeError';
  }
}

function fillPath(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => {
    const value = params[key];
    if (value === undefined || value === null)
      throw new ApiRuntimeError(`Falta el parámetro de ruta ${key}`, 'invalid_args');
    return encodeURIComponent(String(value));
  });
}

function splitArgs(operation: ApiOperation, args: Record<string, unknown>) {
  const pathKeys = new Set(
    Object.keys((operation.pathParams?.properties as Record<string, unknown> | undefined) ?? {})
  );
  const queryKeys = new Set(
    Object.keys((operation.queryParams?.properties as Record<string, unknown> | undefined) ?? {})
  );
  const path: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (pathKeys.has(k)) path[k] = v;
    else if (queryKeys.has(k)) query[k] = v;
    else body[k] = v;
  }
  return { path, query, body };
}

export function buildRequestUrl(
  config: ApiExtensionConfig,
  operation: ApiOperation,
  args: Record<string, unknown>
): URL {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:') throw new ApiRuntimeError('La URL base debe ser HTTPS', 'scheme');
  const { path, query } = splitArgs(operation, args);
  const filled = fillPath(operation.path, path);
  const url = new URL(
    base.pathname.replace(/\/$/, '') + (filled.startsWith('/') ? filled : `/${filled}`),
    base.origin
  );
  if (url.origin !== base.origin)
    throw new ApiRuntimeError('La ruta intenta salir de la URL base', 'invalid_args');
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return url;
}

async function resolveAuth(
  input: ApiExecutionInput,
  config: ApiExtensionConfig
): Promise<{ headers: Record<string, string>; connectionId: string | null }> {
  const scope = input.capability.connectionScope as 'none' | 'team' | 'personal';
  const connection = await resolveConnectionForActor(input.extension.id, scope, input.actor);
  if (!connection) return { headers: {}, connectionId: null };
  let secret: ConnectionSecret;
  if (connection.authType === 'oauth2') secret = await getValidAccessToken(connection.id);
  else secret = await readConnectionSecret(connection.id);
  return {
    headers: buildAuthHeaders(connection.authType, secret, config),
    connectionId: connection.id,
  };
}

/**
 * Executes one approved operation. On a timeout of a non-idempotent write the
 * result is marked `uncertain` so the caller leaves it pending review instead
 * of retrying blindly.
 */
export async function executeApiOperation(input: ApiExecutionInput): Promise<unknown> {
  const config = (input.extension.config as { api?: ApiExtensionConfig } | null)?.api;
  if (!config?.baseUrl)
    throw new ApiRuntimeError('La extensión no tiene URL base configurada', 'config');
  const { operation, args } = input;

  if (input.fixture !== undefined) {
    const fixture = operation.fixtures?.[input.fixture];
    if (fixture === undefined)
      throw new ApiRuntimeError(`Fixture "${input.fixture}" no existe`, 'fixture');
    return selectResponseFields(fixture, operation.responseFields ?? []);
  }

  const url = buildRequestUrl(config, operation, args);
  const policy: EgressPolicy = {
    allowedHosts: input.extension.allowedHosts,
    allowedPorts: input.extension.allowedPorts,
    timeoutMs: Math.min(input.capability.timeoutMs, config.timeoutMs ?? input.capability.timeoutMs),
    maxResponseBytes:
      config.maxResponseBytes ?? Math.max(input.capability.maxResultBytes * 4, 256 * 1024),
  };
  const { headers: authHeaders, connectionId } = await resolveAuth(input, config);
  const { body } = splitArgs(operation, args);
  const hasBody =
    operation.method !== 'GET' && operation.method !== 'DELETE' && Object.keys(body).length > 0;
  const contentType = operation.bodyContentType ?? 'application/json';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(operation.headers ?? {}),
    ...authHeaders,
  };
  let payload: string | null = null;
  if (hasBody) {
    headers['Content-Type'] = contentType;
    payload =
      contentType === 'application/x-www-form-urlencoded'
        ? new URLSearchParams(
            Object.entries(body).map(([k, v]) => [
              k,
              typeof v === 'object' ? JSON.stringify(v) : String(v),
            ])
          ).toString()
        : JSON.stringify(body);
  }

  const attempts =
    operation.method === 'GET' || operation.idempotent
      ? Math.max(1, operation.retry?.attempts ?? 2)
      : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await safeFetch(
        url.toString(),
        { method: operation.method, headers, body: payload },
        policy
      );
      if (connectionId) await touchConnection(connectionId);
      if (res.status === 401 || res.status === 403) {
        throw new ApiRuntimeError(
          `El servicio rechazó la autenticación (HTTP ${res.status})`,
          'auth'
        );
      }
      if (res.status >= 500 && attempt < attempts) {
        lastError = new ApiRuntimeError(`HTTP ${res.status}`, 'upstream');
        await new Promise((r) => setTimeout(r, operation.retry?.backoffMs ?? 500));
        continue;
      }
      let parsed: unknown = null;
      const text = res.body.toString('utf8');
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { text: text.slice(0, input.capability.maxResultBytes) };
        }
      }
      if (res.status >= 400) {
        throw new ApiRuntimeError(
          `El servicio respondió HTTP ${res.status}: ${JSON.stringify(redactDeep(parsed)).slice(0, 500)}`,
          'upstream'
        );
      }
      return {
        status: res.status,
        data: redactDeep(selectResponseFields(parsed, operation.responseFields ?? [])),
      };
    } catch (err) {
      lastError = err;
      if (err instanceof EgressError && err.code === 'timeout') {
        if (connectionId) await touchConnection(connectionId, 'timeout');
        if (operation.method !== 'GET' && !operation.idempotent) {
          // The request may have reached the service: do not retry, report uncertainty.
          return {
            uncertain: true,
            error:
              'Tiempo de espera agotado; la operación pudo haberse completado. Pendiente de revisión.',
          };
        }
        if (attempt < attempts) continue;
      }
      if (err instanceof ApiRuntimeError && err.code === 'auth' && connectionId) {
        await touchConnection(connectionId, err.message);
      }
      if (attempt >= attempts) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ApiRuntimeError('Error desconocido', 'unknown');
}

/**
 * Controlled test for the admin: reads run live; writes only show the exact
 * target and payload unless `confirmWrite` is explicitly set.
 */
export async function testApiOperation(
  input: ApiExecutionInput,
  options: { confirmWrite?: boolean }
): Promise<{
  mode: 'fixture' | 'live' | 'preview';
  target?: string;
  payload?: unknown;
  result?: unknown;
}> {
  if (input.fixture !== undefined) {
    return { mode: 'fixture', result: await executeApiOperation(input) };
  }
  const config = (input.extension.config as { api?: ApiExtensionConfig } | null)?.api;
  if (!config?.baseUrl)
    throw new ApiRuntimeError('La extensión no tiene URL base configurada', 'config');
  const url = buildRequestUrl(config, input.operation, input.args);
  const isWrite = input.operation.method !== 'GET';
  if (isWrite && !options.confirmWrite) {
    const { body } = splitArgs(input.operation, input.args);
    return {
      mode: 'preview',
      target: `${input.operation.method} ${url.toString()}`,
      payload: redactDeep(body),
    };
  }
  return {
    mode: 'live',
    target: `${input.operation.method} ${url.toString()}`,
    result: await executeApiOperation(input),
  };
}
