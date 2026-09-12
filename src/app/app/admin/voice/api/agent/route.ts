import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import {
  getVoiceAgentSettings,
  updateVoiceAgentSettings,
  voiceAgentSettingsSchema,
  VOICE_AGENT_DATA_DOMAINS,
  VOICE_AGENT_MODELS,
  VOICE_AGENT_STT_MODELS,
  VOICE_AGENT_VOICES,
} from '@/modules/voice/voice-agent-settings';
import { previewAgentInstructions } from '@/modules/voice/voice-agent-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireVoiceAdmin() {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'calls.admin')) {
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  }
  return { user: session.user };
}

async function payload() {
  const settings = await getVoiceAgentSettings();
  const preview = await previewAgentInstructions(settings);
  return {
    settings,
    preview,
    catalogs: {
      models: VOICE_AGENT_MODELS,
      voices: VOICE_AGENT_VOICES,
      sttModels: VOICE_AGENT_STT_MODELS,
      domains: VOICE_AGENT_DATA_DOMAINS.map(({ key, label, hint }) => ({ key, label, hint })),
    },
  };
}

/** GET /app/admin/voice/api/agent — calls.admin. Settings, catalogs and prompt preview. */
export async function GET() {
  const auth = await requireVoiceAdmin();
  if ('response' in auth) return auth.response;
  return NextResponse.json(await payload());
}

/** PATCH /app/admin/voice/api/agent — calls.admin (audited). Partial update. */
export async function PATCH(request: NextRequest) {
  const auth = await requireVoiceAdmin();
  if ('response' in auth) return auth.response;
  const parsed = voiceAgentSettingsSchema
    .partial()
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }
  await updateVoiceAgentSettings(parsed.data);
  await recordAuditEvent({
    actorUserId: auth.user.id,
    action: 'voice.agent_settings_changed',
    targetType: 'voice_settings',
    targetId: 'agent',
    metadata: { changedKeys: Object.keys(parsed.data) },
  });
  return NextResponse.json(await payload());
}
