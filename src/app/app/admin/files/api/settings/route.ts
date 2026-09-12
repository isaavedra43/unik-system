import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireFilesAdmin } from '../_auth';
import {
  getStorageSettings,
  updateStorageSettings,
} from '@/modules/storage/storage-settings-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z
  .object({
    partSizeBytes: z
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(1024 * 1024 * 1024),
    multipartThresholdBytes: z
      .number()
      .int()
      .min(1024 * 1024),
    uploadSessionTtlHours: z.number().int().min(1).max(168),
    uploadUrlTtlSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 3600),
    signedUrlTtlSeconds: z.number().int().min(30).max(3600),
    perUserDailyQuotaBytes: z.number().int().min(0),
    environmentDailyQuotaBytes: z.number().int().min(0),
    maxZipExpansionBytes: z
      .number()
      .int()
      .min(1024 * 1024),
    maxZipRatio: z.number().min(1).max(10_000),
    maxZipEntries: z.number().int().min(1).max(100_000),
    inlineValidationWaitMs: z.number().int().min(0).max(30_000),
    recordingRetentionDays: z.number().int().min(0).max(3650),
    transcriptRetentionDays: z.number().int().min(0).max(3650),
    cleanupEnabled: z.boolean(),
    backupEnabled: z.boolean(),
    preferSignedUrls: z.boolean(),
  })
  .partial();

export async function GET() {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ settings: await getStorageSettings() });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const settings = await updateStorageSettings(parsed.data);
  await recordAuditEvent({
    actorUserId: auth.user.id,
    action: 'storage.settings_changed',
    targetType: 'storage_config',
    targetId: 'global',
    metadata: { changedKeys: Object.keys(parsed.data) },
  });
  return NextResponse.json({ settings });
}
