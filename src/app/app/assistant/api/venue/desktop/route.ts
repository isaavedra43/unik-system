import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { attachVenue, currentVenueSession, emitVenueEvent } from '@/modules/venues/venue-manager';
import { json, requireVenueUser, touchSession } from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum([
    'start',
    'screenshot',
    'click',
    'doubleClick',
    'rightClick',
    'type',
    'key',
    'scroll',
    'openApp',
  ]),
  x: z.number().min(0).max(10_000).optional(),
  y: z.number().min(0).max(10_000).optional(),
  direction: z.enum(['up', 'down']).optional(),
  amount: z.number().int().min(1).max(20).optional(),
  text: z.string().max(4000).optional(),
  key: z.string().max(40).optional(),
  /** openApp: only the launcher shortcuts the panel offers. */
  app: z.enum(['terminal', 'files', 'browser', 'editor']).optional(),
});

const APPS: Record<string, string> = {
  terminal: 'xfce4-terminal || x-terminal-emulator || xterm',
  files: 'thunar || nautilus || pcmanfm',
  browser: 'firefox || chromium || chromium-browser || google-chrome',
  editor: 'mousepad || gedit || xed || code',
};

/**
 * POST /app/assistant/api/venue/desktop — the user operates the virtual
 * computer's DESKTOP (not the agent's browser): power on the VNC desktop,
 * click/type on the live screen, launch a terminal or the file manager.
 * Returns the fresh frame.
 */
export async function POST(request: NextRequest) {
  const auth = await requireVenueUser('browser.use');
  if ('response' in auth) return auth.response;
  const { user } = auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Datos inválidos' }, 400);
  const body = parsed.data;

  const vs = await currentVenueSession(user.id);
  if (!vs?.externalId) {
    return json({ error: 'La computadora virtual está apagada — enciéndela primero.' }, 409);
  }
  const venue = await attachVenue(vs.id, user.id, { heal: false, wake: true }).catch(() => null);
  if (!venue) return json({ error: 'No se pudo conectar con la computadora virtual.' }, 502);

  if (body.action === 'start') {
    const status = await venue.ensureDesktop();
    await touchSession(vs.id);
    return json({ ok: status.running, running: status.running, reason: status.reason ?? null });
  }

  const result = await venue.desktopAct(
    body.action === 'openApp'
      ? { action: 'openApp', command: APPS[body.app ?? 'terminal'] }
      : {
          action: body.action,
          x: body.x,
          y: body.y,
          direction: body.direction,
          amount: body.amount,
          text: body.text,
          key: body.key,
        }
  );
  await touchSession(vs.id);
  await emitVenueEvent(vs.id, 'desktop_takeover', { action: body.action, ok: result.ok });
  return json({
    ok: result.ok,
    error: result.error ?? null,
    frame: result.screenshotBase64 ? `data:image/jpeg;base64,${result.screenshotBase64}` : null,
    width: result.width ?? null,
    height: result.height ?? null,
  });
}
