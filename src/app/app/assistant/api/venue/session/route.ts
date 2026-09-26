import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { acquireVenue, stopUserVenue, VenueUnavailableError } from '@/modules/venues/venue-manager';
import { json, requireVenueUser } from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum(['start', 'stop']),
  /** Which surface the user is turning on — the desktop also starts its VNC stack. */
  surface: z.enum(['browser', 'desktop']).optional(),
});

/**
 * POST /app/assistant/api/venue/session — the workspace power button.
 *
 * `start` creates (or wakes) the user's virtual computer and answers as soon
 * as the sandbox exists: the browser stack is prepared in the background and
 * the panel follows its stages through /venue/state. `stop` releases it
 * (bills elapsed minutes). Same guards as the tools: venueEnabled,
 * DAYTONA_API_KEY, concurrency and the daily budget.
 */
export async function POST(request: NextRequest) {
  const auth = await requireVenueUser('browser.use');
  if ('response' in auth) return auth.response;
  const { user } = auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Datos inválidos' }, 400);

  if (parsed.data.action === 'stop') {
    const stopped = await stopUserVenue(user.id);
    return json({ ok: true, stopped });
  }

  try {
    const venue = await acquireVenue({ userId: user.id, purpose: 'panel', warm: 'background' });
    if (parsed.data.surface === 'desktop') {
      void venue.ensureDesktop().catch(() => undefined);
    }
    const health = await venue.health();
    return json({
      ok: true,
      sessionId: venue.id,
      browserReady: health.ok,
      stage: health.stage ?? null,
      reason: health.ok ? null : (health.reason ?? null),
    });
  } catch (err) {
    if (err instanceof VenueUnavailableError) return json({ ok: false, error: err.message }, 409);
    throw err;
  }
}
