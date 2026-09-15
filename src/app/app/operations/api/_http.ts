import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { ProposalError } from '@/modules/extensions/proposals-service';
import { isOperationsError } from '@/modules/operations/errors';

/**
 * HTTP helpers shared by the operations API routes (copilot surfaces, proposal
 * decisions, answers to area requests): session, JSON body and error mapping.
 * Kept apart from `_copilot-shared.ts` so the decision routes never load the
 * assistant and its tools.
 */

export const COPILOT_MAX_BODY_CHARS = 256_000;

export class OperationsCopilotError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'OperationsCopilotError';
  }
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-api', event, ...extra }));

export function jsonError(status: number, error: string, code: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

/** Any signed-in user; each route checks access to its own resource afterwards. */
export async function requireOperationsUser(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session) return { response: jsonError(401, 'No autenticado', 'unauthenticated') };
  return { user: session.user };
}

/**
 * Copilot surfaces (area, case, Mi trabajo, Control Tower): a session AND `assistant.use`, the same
 * gate as the main assistant. Each route adds the check of its own surface afterwards.
 */
export async function requireCopilotUser(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth;
  if (!hasPermission(auth.user, 'assistant.use')) {
    return { response: jsonError(403, 'No tienes acceso al asistente de IA', 'forbidden') };
  }
  return auth;
}

export function operationsCopilotErrorResponse(err: unknown): NextResponse {
  if (err instanceof OperationsCopilotError) {
    return NextResponse.json(
      { error: err.message, ...(err.code ? { code: err.code } : {}) },
      { status: err.status }
    );
  }
  if (err instanceof ProposalError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (isOperationsError(err)) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'Datos inválidos', code: 'invalid_request', details: err.issues.slice(0, 10) },
      { status: 400 }
    );
  }
  log('unexpected_error', { message: err instanceof Error ? err.message : String(err) });
  return jsonError(500, 'Error interno', 'internal_error');
}

export async function readCopilotJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new OperationsCopilotError('No se pudo leer la solicitud', 400, 'invalid_request');
  }
  if (text.length > COPILOT_MAX_BODY_CHARS) {
    throw new OperationsCopilotError('La solicitud es demasiado grande', 413, 'payload_too_large');
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new OperationsCopilotError('JSON inválido', 400, 'invalid_request');
  }
}
