import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { acquireVenue, stopUserVenue, VenueUnavailableError } from '@/modules/venues/venue-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ action: z.enum(['start', 'stop']) });

/**
 * POST /app/assistant/api/venue/session — the panel's power button.
 *
 * `start` provisions (or reattaches) the user's virtual computer without a
 * chat turn, so the browser can be turned on from the workspace itself;
 * `stop` releases it (bills elapsed minutes). Same guards as the tools:
 * venueEnabled, DAYTONA_API_KEY, concurrency and daily budget.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'browser.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  if (parsed.data.action === 'stop') {
    const stopped = await stopUserVenue(session.user.id);
    return NextResponse.json({ ok: true, stopped });
  }

  try {
    const venue = await acquireVenue({ userId: session.user.id, purpose: 'panel' });
    const health = await venue.health();
    return NextResponse.json({
      ok: true,
      sessionId: venue.id,
      browserReady: health.ok,
      reason: health.ok ? null : (health.reason ?? null),
    });
  } catch (err) {
    if (err instanceof VenueUnavailableError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
