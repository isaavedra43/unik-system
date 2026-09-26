import type { NextRequest } from 'next/server';
import { attachVenue, currentVenueSession } from '@/modules/venues/venue-manager';
import { DEFAULT_VENUE_HOME, json, requireVenueUser } from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/assistant/api/venue/files?path=/home/daytona — directory listing for the file browser. */
export async function GET(request: NextRequest) {
  const auth = await requireVenueUser('venue.files');
  if ('response' in auth) return auth.response;
  const raw = request.nextUrl.searchParams.get('path') || DEFAULT_VENUE_HOME;
  if (!raw.startsWith('/') || raw.includes('\0') || raw.length > 1000) {
    return json({ error: 'Ruta inválida' }, 400);
  }
  const vs = await currentVenueSession(auth.user.id);
  if (!vs?.externalId) return json({ error: 'La computadora virtual está apagada.' }, 409);
  const venue = await attachVenue(vs.id, auth.user.id, { heal: false }).catch(() => null);
  if (!venue || (venue.sandboxState && venue.sandboxState !== 'started')) {
    return json({ error: 'La computadora virtual está en pausa.' }, 409);
  }
  try {
    const files = await venue.listFiles(raw);
    files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return json({ path: raw, files });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message.slice(0, 200) : 'No se pudo listar' },
      502
    );
  }
}
