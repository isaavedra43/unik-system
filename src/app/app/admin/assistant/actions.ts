'use server';

import { z } from 'zod';
import { getCurrentSession, hasPermission, AuthorizationError } from '@/modules/auth/authorization';
import { updateAiConfig, listAiConfig } from '@/modules/ai/ai-admin-config-service';
import { recordAiAuditEvent } from '@/modules/ai/ai-audit';
import { testAiConnection } from '@/modules/ai/ai-client';

async function requireAdmin() {
  const session = await getCurrentSession();
  if (!session) throw new AuthorizationError('No autenticado');
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    throw new AuthorizationError('Sin permiso para administrar el asistente');
  }
  return session.user;
}

const updateConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
});

export async function updateAiConfigAction(
  input: z.infer<typeof updateConfigSchema>
): Promise<{ ok: true }> {
  const user = await requireAdmin();
  const parsed = updateConfigSchema.parse(input);
  await updateAiConfig(parsed);
  await recordAiAuditEvent({
    actorUserId: user.id,
    action: 'assistant.config_changed',
    targetType: 'ai_config',
    targetId: 'global',
    metadata: { isEnabled: parsed.isEnabled, changedKeys: parsed.settings ? Object.keys(parsed.settings) : [] },
  });
  return { ok: true };
}

export async function toggleAiEnabledAction(): Promise<{ isEnabled: boolean }> {
  const user = await requireAdmin();
  const current = await listAiConfig();
  const newEnabled = !current.isEnabled;
  await updateAiConfig({ isEnabled: newEnabled });
  await recordAiAuditEvent({
    actorUserId: user.id,
    action: 'assistant.toggled',
    targetType: 'ai_config',
    targetId: 'global',
    metadata: { isEnabled: newEnabled },
  });
  return { isEnabled: newEnabled };
}

export async function testAiConnectionAction(): Promise<{
  success: boolean;
  deployment?: string;
  latencyMs?: number;
  tokensUsed?: number;
  error?: string;
  errorCode?: string;
}> {
  await requireAdmin();
  return testAiConnection();
}
