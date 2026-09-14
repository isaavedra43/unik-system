import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import { sendTestPush } from '@/modules/notifications/push-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ endpoint: z.string().url().max(2000).optional() });

/** POST: sends a test push to this device (or every device of the user). */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // no body = all devices
  }
  const parsed = schema.safeParse(body ?? {});
  const result = await sendTestPush(session.user.id, parsed.success ? parsed.data.endpoint : undefined);
  return NextResponse.json(result);
}
