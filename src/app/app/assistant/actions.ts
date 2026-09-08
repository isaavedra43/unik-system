'use server';

import { z } from 'zod';
import {
  getCurrentSession,
  hasPermission,
  AuthorizationError,
} from '@/modules/auth/authorization';
import {
  createConversation,
  deleteConversation,
  renameConversation,
  toggleStar,
} from '@/modules/ai/ai-sessions-service';

async function requireAssistant() {
  const session = await getCurrentSession();
  if (!session) throw new AuthorizationError('No autenticado');
  if (!hasPermission(session.user, 'assistant.use')) {
    throw new AuthorizationError('Sin permiso para usar el asistente');
  }
  return session.user;
}

const createConversationSchema = z.object({
  context: z.record(z.unknown()).optional(),
});

export async function createConversationAction(
  input: z.infer<typeof createConversationSchema>
): Promise<{ id: string }> {
  const user = await requireAssistant();
  const parsed = createConversationSchema.parse(input);
  const { id } = await createConversation(user.id, parsed.context);
  return { id };
}

const deleteConversationSchema = z.object({
  id: z.string().min(1),
});

export async function deleteConversationAction(
  input: z.infer<typeof deleteConversationSchema>
): Promise<{ ok: true }> {
  const user = await requireAssistant();
  const parsed = deleteConversationSchema.parse(input);
  await deleteConversation(parsed.id, user.id);
  return { ok: true };
}

const renameConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(100),
});

export async function renameConversationAction(
  input: z.infer<typeof renameConversationSchema>
): Promise<{ ok: true }> {
  const user = await requireAssistant();
  const parsed = renameConversationSchema.parse(input);
  await renameConversation(parsed.id, user.id, parsed.title);
  return { ok: true };
}

const toggleStarSchema = z.object({
  id: z.string().min(1),
});

export async function toggleStarAction(
  input: z.infer<typeof toggleStarSchema>
): Promise<{ ok: true }> {
  const user = await requireAssistant();
  const parsed = toggleStarSchema.parse(input);
  await toggleStar(parsed.id, user.id);
  return { ok: true };
}
