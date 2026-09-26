import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { isUrlDenied } from '@/modules/web/fetch-service';
import { attachVenue, currentVenueSession, emitVenueEvent } from '@/modules/venues/venue-manager';
import {
  browserFramePayload,
  json,
  metaOf,
  recordTeachStep,
  requireVenueUser,
  stepFromTakeover,
  teachOf,
  touchSession,
} from '@/modules/venues/venue-http';
import type { BrowserActInput } from '@/modules/venues/venue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum([
    'navigate',
    'newTab',
    'back',
    'forward',
    'reload',
    'clickAt',
    'typeText',
    'key',
    'wheel',
    'switchTab',
    'closeTab',
  ]),
  url: z.string().max(2000).optional(),
  x: z.number().min(0).max(10_000).optional(),
  y: z.number().min(0).max(10_000).optional(),
  deltaX: z.number().min(-5000).max(5000).optional(),
  deltaY: z.number().min(-5000).max(5000).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  text: z.string().max(4000).optional(),
  key: z.string().max(40).optional(),
  tabId: z.string().max(20).optional(),
});

/** Same rule as the browser's omnibox: URL-looking input opens, anything else searches. */
function toUrl(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

/**
 * POST /app/assistant/api/venue/browser — the user takes the wheel of the
 * agent's browser from the workspace: type an address, click and type on the
 * live frame, scroll, switch tabs. Returns the fresh frame.
 *
 * While "Enséñale" is recording, each action is stored as a replayable step
 * (element selector + text, never coordinates; passwords become a parameter).
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

  let input: BrowserActInput;
  if (body.action === 'navigate' || body.action === 'newTab') {
    if (!body.url?.trim()) return json({ error: 'Escribe una dirección o búsqueda' }, 400);
    const url = toUrl(body.url);
    const settings = await getAiSettings();
    const denied = isUrlDenied(
      url,
      (settings.webDomainAllowlist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
      (settings.webDomainDenylist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
    );
    if (denied) return json({ error: denied }, 403);
    input = { action: body.action === 'navigate' ? 'open' : 'newTab', url };
  } else {
    input = {
      action: body.action,
      x: body.x,
      y: body.y,
      deltaX: body.deltaX,
      deltaY: body.deltaY,
      button: body.button,
      clickCount: body.clickCount,
      text: body.text,
      key: body.key,
      tabId: body.tabId,
    };
  }

  const venue = await attachVenue(vs.id, user.id, { heal: false, wake: true }).catch(() => null);
  if (!venue) return json({ error: 'No se pudo conectar con la computadora virtual.' }, 502);
  const health = await venue.health();
  if (!health.ok) {
    void venue.ensureBrowser().catch(() => undefined);
    return json(
      {
        error: 'El navegador todavía se está preparando.',
        booting: true,
        stage: health.stage,
        reason: health.reason ?? null,
      },
      409
    );
  }

  const result = await venue.browserAct({ ...input, timeoutMs: 25_000 });
  await touchSession(vs.id);
  await emitVenueEvent(vs.id, 'browser_takeover', {
    action: input.action,
    url: result.url,
    ok: result.ok,
  });

  let teachSteps: number | null = null;
  if (result.ok && teachOf(metaOf(vs))) {
    const step = stepFromTakeover(input, result);
    if (step) teachSteps = await recordTeachStep(vs.id, step);
  }

  return json({ ...browserFramePayload(result), teachSteps });
}
