import type { NextRequest } from 'next/server';
import { attachVenue, currentVenueSession, emitVenueEvent } from '@/modules/venues/venue-manager';
import {
  DEFAULT_VENUE_HOME,
  json,
  requireVenueUser,
  touchSession,
} from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_UPLOAD = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  html: 'text/plain; charset=utf-8', // never rendered as HTML from our origin
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
};

function safePath(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.includes('\0') || raw.length > 1000) return null;
  return raw;
}

async function liveVenue(userId: string) {
  const vs = await currentVenueSession(userId);
  if (!vs?.externalId)
    return { error: json({ error: 'La computadora virtual está apagada.' }, 409) };
  const venue = await attachVenue(vs.id, userId, { heal: false }).catch(() => null);
  if (!venue || (venue.sandboxState && venue.sandboxState !== 'started')) {
    return { error: json({ error: 'La computadora virtual está en pausa.' }, 409) };
  }
  return { venue, sessionId: vs.id };
}

/**
 * GET /app/assistant/api/venue/file?path=/home/daytona/reporte.pdf — download
 * a file the agent produced inside the virtual computer. Always served as an
 * attachment (never rendered inline from our origin).
 */
export async function GET(request: NextRequest) {
  const auth = await requireVenueUser('venue.files');
  if ('response' in auth) return auth.response;
  const filePath = safePath(request.nextUrl.searchParams.get('path'));
  if (!filePath) return json({ error: 'Ruta inválida' }, 400);
  const live = await liveVenue(auth.user.id);
  if ('error' in live) return live.error;
  try {
    const buf = await live.venue.readFileBuffer(filePath, MAX_DOWNLOAD);
    const name = filePath.split('/').pop() || 'archivo';
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message.slice(0, 200) : 'No se pudo descargar' },
      502
    );
  }
}

/**
 * POST /app/assistant/api/venue/file (multipart: file, dir?) — the user drops a
 * file into the virtual computer (plans, spreadsheets, images) so the agent
 * can work on it. Lands in ~/uploads by default.
 */
export async function POST(request: NextRequest) {
  const auth = await requireVenueUser('venue.files');
  if ('response' in auth) return auth.response;
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return json({ error: 'Adjunta un archivo' }, 400);
  if (file.size > MAX_UPLOAD) return json({ error: 'Máximo 10 MB por archivo' }, 413);
  const dir = safePath(String(form?.get('dir') ?? '')) ?? `${DEFAULT_VENUE_HOME}/uploads`;
  const name = file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'archivo';
  const live = await liveVenue(auth.user.id);
  if ('error' in live) return live.error;
  try {
    const target = `${dir.replace(/\/$/, '')}/${name}`;
    await live.venue.writeFile(target, Buffer.from(await file.arrayBuffer()));
    await touchSession(live.sessionId);
    await emitVenueEvent(live.sessionId, 'file_write', { path: target, bytes: file.size });
    return json({ ok: true, path: target, bytes: file.size });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message.slice(0, 200) : 'No se pudo subir' },
      502
    );
  }
}
