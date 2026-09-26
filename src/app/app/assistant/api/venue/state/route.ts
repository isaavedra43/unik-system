import type { NextRequest } from 'next/server';
import { attachVenue, currentVenueSession } from '@/modules/venues/venue-manager';
import {
  browserFramePayload,
  json,
  metaOf,
  pendingInputsOf,
  requireVenueUser,
  teachOf,
} from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/venue/state?surface=browser|desktop|none&quality=55
 *
 * Live state of the caller's virtual computer for the workspace column. The
 * BROWSER and the COMPUTER are reported separately (they are different
 * surfaces); only the one the user is looking at gets a fresh frame, so the
 * poll stays cheap.
 *
 * Passive: it never wakes a paused sandbox, never provisions synchronously
 * (a background heal is kicked through the per-sandbox lock) and never counts
 * as usage — watching the panel cannot keep a computer alive by itself.
 * Sensitive values of secure-input requests are never included.
 */
export async function GET(request: NextRequest) {
  const auth = await requireVenueUser('browser.use');
  if ('response' in auth) return auth.response;
  const { user } = auth;

  const surface = request.nextUrl.searchParams.get('surface') ?? 'none';
  const quality = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get('quality')) || 55, 20),
    85
  );

  const vs = await currentVenueSession(user.id);
  if (!vs?.externalId) return json({ active: false });

  const meta = metaOf(vs);
  const pendingInputs = pendingInputsOf(meta);
  const teach = teachOf(meta);
  const base = {
    active: true,
    sessionId: vs.id,
    startedAt: vs.createdAt.toISOString(),
    pendingInputs,
    teach: teach ? { recording: true, steps: teach.steps.length } : { recording: false, steps: 0 },
  };

  let venue;
  try {
    venue = await attachVenue(vs.id, user.id, { heal: false });
  } catch {
    // Sandbox gone (deleted/expired) — the row is stale; the next start recreates.
    return json({ active: false, pendingInputs });
  }

  const sandboxState = venue.sandboxState ?? 'started';
  if (sandboxState !== 'started') {
    return json({
      ...base,
      paused: true,
      sandboxState,
      browser: { ready: false, stage: 'starting', reason: 'La computadora está en pausa.' },
      desktop: { running: false, reason: 'La computadora está en pausa.' },
    });
  }

  const [health, desktop] = await Promise.all([
    venue.health(),
    venue.desktopStatus().catch(() => ({ running: false, reason: undefined })),
  ]);

  let browserFrame = null;
  if (surface === 'browser' && health.ok) {
    const r = await venue.browserAct({ action: 'frame', quality, timeoutMs: 15_000 });
    browserFrame = browserFramePayload(r);
  }

  let desktopFrame = null;
  if (surface === 'desktop' && desktop.running) {
    const r = await venue.desktopAct({ action: 'screenshot', quality });
    if (r.ok && r.screenshotBase64) {
      desktopFrame = {
        frame: `data:image/jpeg;base64,${r.screenshotBase64}`,
        width: r.width ?? null,
        height: r.height ?? null,
      };
    }
  }

  return json({
    ...base,
    paused: false,
    sandboxState,
    browser: {
      ready: health.ok,
      stage: health.stage ?? (health.ok ? 'ready' : 'starting'),
      reason: health.ok ? null : (health.reason ?? null),
      ...(browserFrame ?? {}),
    },
    desktop: {
      running: desktop.running,
      reason: desktop.running ? null : (desktop.reason ?? null),
      ...(desktopFrame ?? {}),
    },
  });
}
