import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireFilesAdmin } from '../../_auth';
import { restoreObjectFromBackup } from '@/modules/storage/storage-backup-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z.object({ objectId: z.string().min(1).max(100) });

/** POST → restore ONE object from the backup account, verifying its checksum. */
export async function POST(request: NextRequest) {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  const result = await restoreObjectFromBackup(parsed.data.objectId);
  await recordAuditEvent({
    actorUserId: auth.user.id,
    action: 'storage.object_restored',
    targetType: 'storage_object',
    targetId: parsed.data.objectId,
    metadata: { restored: result.restored, reason: result.reason ?? null },
  });
  return NextResponse.json(result, { status: result.restored ? 200 : 409 });
}
