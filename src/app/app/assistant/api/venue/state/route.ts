import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import { attachVenue } from '@/modules/venues/venue-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PendingSecureInput {
  id: string;
  fields: { selector: string; label: string; sensitive?: boolean }[];
  message?: string | null;
  ts: string;
}

/**
 * GET /app/assistant/api/venue/state
 *
 * Live-state poll for the workspace "Pantalla" section: the caller's latest
 * active venue session, a fresh screenshot of the agent's browser page (the
 * sandbox desktop itself is headless — the controller's page screenshot is
 * what the user wants to see) and any pending secure-input requests.
 *
 * Values marked `sensitive` are never included here — only field metadata.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'browser.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const vs = await prisma.venueSession.findFirst({
    where: { userId: session.user.id, status: { in: ['active', 'idle'] } },
    orderBy: { lastUsedAt: 'desc' },
  });
  if (!vs?.externalId) return NextResponse.json({ active: false });

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

  try {
    const venue = await attachVenue(vs.id, session.user.id);
    const shot = await venue.browserAct({ action: 'screenshot', timeoutMs: 15_000 });
    if (!shot.ok || !shot.screenshotBase64) {
      // Browser exists but has no page yet (or is still booting).
      return NextResponse.json({
        active: true,
        sessionId: vs.id,
        screen: null,
        pendingInputs,
      });
    }
    return NextResponse.json({
      active: true,
      sessionId: vs.id,
      screen: {
        dataUrl: `data:image/jpeg;base64,${shot.screenshotBase64}`,
        url: shot.url ?? null,
        title: shot.title ?? null,
      },
      pendingInputs,
    });
  } catch {
    return NextResponse.json({ active: false, pendingInputs });
  }
}
