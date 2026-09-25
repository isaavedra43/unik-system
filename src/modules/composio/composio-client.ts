import { Composio } from '@composio/core';

/**
 * Composio SDK singleton. The API key lives ONLY in the server environment
 * (Railway variable `COMPOSIO_API_KEY`): it is never stored in PostgreSQL, sent
 * to the browser or written to logs. Composio holds the connected accounts
 * (OAuth tokens included); UNIK only keeps its own governance policy.
 */

let client: Composio | null = null;

export function isComposioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
}

export function getComposio(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new ComposioError(
      'Composio no está configurado: falta la variable COMPOSIO_API_KEY en el servidor.',
      'not_configured',
      503
    );
  }
  if (!client) {
    const baseURL = process.env.COMPOSIO_BASE_URL?.trim();
    client = new Composio({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      allowTracking: false,
    });
  }
  return client;
}

/** Test helper. */
export function resetComposioClient(): void {
  client = null;
}

export type ComposioErrorCode =
  | 'not_configured'
  | 'toolkit_not_allowed'
  | 'tool_not_allowed'
  | 'tool_not_found'
  | 'not_connected'
  | 'invalid_args'
  | 'upstream'
  | 'forbidden';

export class ComposioError extends Error {
  constructor(
    message: string,
    public readonly code: ComposioErrorCode,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'ComposioError';
  }
}

/** Composio userId for a UNIK user. Stable, opaque, never an email. */
export function composioUserId(userId: string): string {
  return `unik_${userId}`;
}
