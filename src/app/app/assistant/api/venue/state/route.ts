import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { attachVenue, currentVenueSession } from '@/modules/venues/venue-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PendingSecureInput {
  id: string;
  fields: { selector: string; label: string; sensitive?: boolean }[];
  message?: string | null;
  ts: string;
}

/** Screenshots are ephemeral: the frame lives only in this response, never cached. */
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
} as const;

function stateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * GET /app/assistant/api/venue/state
 *
 * Live-state poll for the workspace "Navegador" surface: the caller's latest
 * active venue session, a fresh screenshot of the agent's browser page (the
 * sandbox desktop itself is headless — the controller's page screenshot is
 * what the user wants to see) and any pending secure-input requests.
 *
 * This is a passive read: it never provisions (that is the tool call's job)
 * and never counts as usage, so watching the panel cannot keep a sandbox
 * alive by itself. While the browser is still booting it answers
 * `active:true, booting:true` with the real reason instead of flipping the
 * panel to "off".
 *
 * Values marked `sensitive` are never included here — only field metadata.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'browser.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const vs = await currentVenueSession(session.user.id);
  if (!vs?.externalId) return stateJson({ active: false });

  const meta = (vs.metadata as Record<string, unknown> | null) ?? {};
  const cutoff = Date.now() - 30 * 60_000;
  const pendingInputs = ((meta.pendingSecureInputs as PendingSecureInput[] | undefined) ?? [])
    .filter((r) => new Date(r.ts).getTime() > cutoff)
    .map((r) => ({
      requestId: r.id,
      message: r.message ?? null,
      fields: (r.fields ?? []).map((f) => ({
        selector: f.selector,
        label: f.label,
        sensitive: f.sensitive === true,
      })),
    }));

  let venue;
  try {
    venue = await attachVenue(vs.id, session.user.id, { heal: false });
  } catch {
    // Sandbox gone (deleted/expired) — the row is stale; the next tool call recreates.
    return stateJson({ active: false, pendingInputs });
  }

  const health = await venue.health();
  if (!health.ok) {
    return stateJson({
      active: true,
      booting: true,
      sessionId: vs.id,
      screen: null,
      reason: health.reason ?? null,
      pendingInputs,
    });
  }

  const shot = await venue.browserAct({ action: 'screenshot', timeoutMs: 15_000 });
  if (!shot.ok || !shot.screenshotBase64) {
    // Browser is up but has no page yet.
    return stateJson({
      active: true,
      booting: false,
      sessionId: vs.id,
      screen: null,
      pendingInputs,
    });
  }
  return stateJson({
    active: true,
    booting: false,
    sessionId: vs.id,
    screen: {
      dataUrl: `data:image/jpeg;base64,${shot.screenshotBase64}`,
      url: shot.url ?? null,
      title: shot.title ?? null,
    },
    pendingInputs,
  });
}
