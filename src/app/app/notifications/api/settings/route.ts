import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import { NOTIFICATION_CATALOG } from '@/modules/notifications/catalog';
import {
  getNotificationSettings,
  updateNotificationSettings,
} from '@/modules/notifications/preferences-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const settings = await getNotificationSettings(session.user.id);
  return NextResponse.json({ settings, catalog: NOTIFICATION_CATALOG });
}

const hour = z.number().int().min(0).max(23).nullable();
const updateSchema = z.object({
  pushEnabled: z.boolean().optional(),
  quietHoursStart: hour.optional(),
  quietHoursEnd: hour.optional(),
  timezone: z.string().min(1).max(64).optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
  categories: z
    .record(z.object({ inApp: z.boolean().optional(), push: z.boolean().optional() }))
    .optional(),
});

export async function PUT(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos', details: parsed.error.issues }, { status: 400 });
  }
  const settings = await updateNotificationSettings(session.user.id, parsed.data);
  return NextResponse.json({ settings });
}
