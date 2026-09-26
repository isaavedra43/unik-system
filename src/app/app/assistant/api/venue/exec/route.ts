import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  attachVenue,
  currentVenueSession,
  emitVenueEvent,
  isVenueEnabled,
} from '@/modules/venues/venue-manager';
import {
  DEFAULT_VENUE_HOME,
  json,
  requireVenueUser,
  touchSession,
} from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().max(1000).optional(),
  timeoutSec: z.number().int().min(1).max(120).optional(),
});

/**
 * POST /app/assistant/api/venue/exec — the user's own terminal on the virtual
 * computer (the same sandbox the agents use). The user is the actor, so no
 * approval step; `venue.exec` is still required. Output is capped and returned
 * as text only.
 */
export async function POST(request: NextRequest) {
  const auth = await requireVenueUser('venue.exec');
  if ('response' in auth) return auth.response;
  if (!(await isVenueEnabled()))
    return json({ error: 'La computadora virtual no está habilitada.' }, 409);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Datos inválidos' }, 400);
  const cwd =
    parsed.data.cwd && parsed.data.cwd.startsWith('/') && !parsed.data.cwd.includes('\0')
      ? parsed.data.cwd
      : DEFAULT_VENUE_HOME;

  const vs = await currentVenueSession(auth.user.id);
  if (!vs?.externalId)
    return json({ error: 'La computadora virtual está apagada — enciéndela primero.' }, 409);
  const venue = await attachVenue(vs.id, auth.user.id, { heal: false, wake: true }).catch(
    () => null
  );
  if (!venue) return json({ error: 'No se pudo conectar con la computadora virtual.' }, 502);
  try {
    const res = await venue.exec(parsed.data.command, {
      cwd,
      timeoutSec: parsed.data.timeoutSec ?? 60,
    });
    await touchSession(vs.id);
    await emitVenueEvent(vs.id, 'exec', {
      command: parsed.data.command.slice(0, 200),
      exitCode: res.exitCode,
      by: 'user',
    });
    const output = res.stdout ?? '';
    return json({
      exitCode: res.exitCode,
      output: output.slice(-20_000),
      truncated: output.length > 20_000,
      cwd,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message.slice(0, 300) : 'No se pudo ejecutar' },
      502
    );
  }
}
