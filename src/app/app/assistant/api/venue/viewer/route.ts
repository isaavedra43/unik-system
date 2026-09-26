import { attachVenue, currentVenueSession } from '@/modules/venues/venue-manager';
import { json, requireVenueUser } from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/venue/viewer — a signed noVNC URL (1 h) to open the
 * virtual computer's desktop full screen in its own browser tab (real-time
 * mouse and keyboard). Never embedded in the app: the app's CSP forbids
 * external frames, and a new tab keeps Daytona's origin separate from ours.
 */
export async function GET() {
  const auth = await requireVenueUser('browser.use');
  if ('response' in auth) return auth.response;
  const vs = await currentVenueSession(auth.user.id);
  if (!vs?.externalId) return json({ error: 'La computadora virtual está apagada.' }, 409);
  const venue = await attachVenue(vs.id, auth.user.id, { heal: false }).catch(() => null);
  if (!venue) return json({ error: 'No se pudo conectar con la computadora virtual.' }, 502);
  const url = await venue.desktopViewerUrl().catch(() => null);
  if (!url) return json({ error: 'Enciende el escritorio primero.' }, 409);
  return json({ url });
}
