import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { ChatCopilotError } from '@/modules/chat/chat-copilot';
import { ProposalError } from '@/modules/extensions/proposals-service';

export async function requireChatUser(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const session = await getCurrentSession();
  if (!session) return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'chat.use')) {
    return { response: NextResponse.json({ error: 'Sin permiso para el chat' }, { status: 403 }) };
  }
  return { user: session.user };
}

export function chatCopilotErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChatCopilotError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ProposalError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  const message = err instanceof Error ? err.message : 'Error desconocido';
  console.error('[chat-copilot-api]', message);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ChatCopilotError('JSON inválido', 400);
  }
}
