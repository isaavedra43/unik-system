import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getAiConfigStatus } from '@/modules/ai/ai-config';
import { isAiEnabled } from '@/modules/ai/ai-admin-config-service';
import { getRecentErrors } from '@/modules/ai/ai-admin-service';
import { PROVIDER_LABELS } from '@/modules/ai/providers';
import type { ProviderId } from '@/modules/ai/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const status = await getAiConfigStatus();
  const enabled = await isAiEnabled();
  const recentErrors = await getRecentErrors(20);

  return NextResponse.json({
    provider: status.provider,
    providerLabel: PROVIDER_LABELS[status.provider as ProviderId] ?? status.provider,
    isConfigured: status.configured,
    hasApiKey: status.hasApiKey,
    hasEndpoint: status.hasEndpoint,
    hasModel: status.hasModel,
    model: status.model ?? '—',
    fallbackModel: status.fallbackModel ?? '—',
    endpoint: status.endpoint ?? '—',
    isEnabled: enabled,
    missingVars: status.missingVars,
    recentErrors: recentErrors.map((e) => ({
      id: e.id,
      errorCode: e.errorCode,
      deployment: e.deployment,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
