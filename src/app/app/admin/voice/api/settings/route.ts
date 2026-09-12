import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { prisma } from '@/lib/prisma';
import { getStorageSettings } from '@/modules/storage/storage-settings-service';
import { getLiveKitStatus } from '@/modules/voice/livekit-service';
import {
  getVoiceSettings,
  updateVoiceSettings,
  VOICE_TASK_TYPE_CATALOG,
} from '@/modules/voice/voice-settings';

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

const catalogTypes = VOICE_TASK_TYPE_CATALOG.map((t) => t.type) as [string, ...string[]];

const patchSchema = z
  .object({
    allowedTaskTypes: z.array(z.enum(catalogTypes)).max(20),
    aiAnswerByAccount: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.boolean()),
    aiAnswerDefault: z.boolean(),
    copilotEnabled: z.boolean(),
    copilotEveryNSegments: z.number().int().min(1).max(50),
    recordByDefault: z.boolean(),
    defaultTaskOwnerUserId: z.string().min(1).max(64).nullable(),
    maxAiAnswerSeconds: z.number().int().min(30).max(3600),
  })
  .partial();

async function payload() {
  const [settings, storage, accounts, twilioConfigured] = await Promise.all([
    getVoiceSettings(),
    getStorageSettings(),
    prisma.commAccount.findMany({
      where: { provider: { startsWith: 'twilio' } },
      select: { id: true, label: true, identifier: true, status: true, teamKeys: true },
      orderBy: { label: 'asc' },
    }),
    Promise.resolve(Boolean(process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WEBHOOK_BASE_URL)),
  ]);
  return {
    settings,
    catalog: VOICE_TASK_TYPE_CATALOG,
    retention: {
      recordingRetentionDays: storage.recordingRetentionDays,
      transcriptRetentionDays: storage.transcriptRetentionDays,
    },
    accounts,
    status: { livekit: getLiveKitStatus(), twilioWebhookConfigured: twilioConfigured },
  };
}

/** GET /app/admin/voice/api/settings — calls.admin */
export async function GET() {
  const auth = await requireVoiceAdmin();
  if ('response' in auth) return auth.response;
  return NextResponse.json(await payload());
}

/** PATCH /app/admin/voice/api/settings — calls.admin (audited; retention is read-only here). */
export async function PATCH(request: NextRequest) {
  const auth = await requireVoiceAdmin();
  if ('response' in auth) return auth.response;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }
  if (parsed.data.defaultTaskOwnerUserId) {
    const user = await prisma.user.findUnique({
      where: { id: parsed.data.defaultTaskOwnerUserId },
      select: { id: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return NextResponse.json(
        { error: 'El usuario responsable no existe o está inactivo' },
        { status: 400 }
      );
    }
  }
  await updateVoiceSettings(parsed.data);
  await recordAuditEvent({
    actorUserId: auth.user.id,
    action: 'voice.settings_changed',
    targetType: 'voice_settings',
    targetId: 'global',
    metadata: { changedKeys: Object.keys(parsed.data) },
  });
  return NextResponse.json(await payload());
}
