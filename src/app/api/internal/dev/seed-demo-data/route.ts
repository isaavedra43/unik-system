import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/modules/auth/authorization';
import { seedDemoData, clearDemoData } from '@/modules/dev/seed-demo-data';

export const runtime = 'nodejs';

/**
 * Local-only helper: fills every module with fake demo data so the frontend
 * can be reviewed screen by screen. Hard-disabled in production, on top of
 * the same guard inside seedDemoData itself.
 */
export async function POST() {
  if (process.env.NEXT_PUBLIC_ALLOW_DEMO_SEED !== 'true') {
    return NextResponse.json({ error: 'Not available' }, { status: 403 });
  }

  const user = await getCurrentUser();
  if (!user || !user.isSuperAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await seedDemoData(user.id);
    return NextResponse.json({ status: 'seeded', summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Seed failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  if (process.env.NEXT_PUBLIC_ALLOW_DEMO_SEED !== 'true') {
    return NextResponse.json({ error: 'Not available' }, { status: 403 });
  }

  const user = await getCurrentUser();
  if (!user || !user.isSuperAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await clearDemoData();
  return NextResponse.json({ status: 'cleared' });
}
