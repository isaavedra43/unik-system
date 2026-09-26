import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { attachVenue, emitVenueEvent } from '@/modules/venues/venue-manager';
import { fieldKey, type PendingSecureInput } from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /app/assistant/api/venue/secure-input
 *
 * User takeover for the virtual browser: the agent's browser.secureInput call
 * declared which page fields it needs; the user typed them into the masked
 * workspace form; this route types them into the page via useCredential.
 *
 * Values are NEVER returned, logged, stored or shown to the model — they flow
 * request → controller → page fill, then die.
 */

const bodySchema = z.object({
  sessionId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(64),
  values: z.record(z.string(), z.string().max(4000)),
});


export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'browser.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Payload inválido' }, { status: 400 });
  const { sessionId, requestId, values } = parsed.data;

  const vs = await prisma.venueSession.findFirst({
    where: { id: sessionId, userId: session.user.id },
  });
  if (!vs) return NextResponse.json({ error: 'Sesión no encontrada' }, { status: 404 });
  if (vs.status !== 'active' && vs.status !== 'idle') {
    return NextResponse.json({ error: 'La sesión ya terminó' }, { status: 410 });
  }

  const meta = (vs.metadata as Record<string, unknown> | null) ?? {};
  const pending = (meta.pendingSecureInputs as PendingSecureInput[] | undefined) ?? [];
  const req = pending.find(
    (r) => r.id === requestId && Date.now() - new Date(r.ts).getTime() < 30 * 60_000
  );
  if (!req) {
    return NextResponse.json({ error: 'La solicitud expiró o ya se usó — pide otra al asistente' }, { status: 410 });
  }

  // Type each field straight into the page. The plaintext only exists inside
  // this call — the controller's useCredential fills it without echoing back.
  try {
    const venue = await attachVenue(sessionId, session.user.id);
    let filled = 0;
    for (const field of req.fields) {
      const value = values[fieldKey(field)];
      if (typeof value !== 'string' || value.length === 0) continue;
      const res = await venue.browserAct({
        action: 'useCredential',
        ...(field.selector ? { selector: field.selector } : { ref: field.ref }),
        secretValue: value,
        timeoutMs: 15_000,
      });
      if (!res.ok) {
        return NextResponse.json(
          { error: `No se pudo escribir "${field.label}" en la página — ${res.error ?? 'campo no encontrado'}` },
          { status: 502 }
        );
      }
      filled++;
    }

    // Consume the request — one-shot, never replayable.
    await prisma.venueSession.update({
      where: { id: sessionId },
      data: {
        metadata: {
          ...meta,
          pendingSecureInputs: pending.filter(
            (r) => r.id !== requestId
          ) as unknown as Prisma.InputJsonValue,
        },
      },
    });
    await emitVenueEvent(sessionId, 'secure_input_done', { requestId });
    return NextResponse.json({ ok: true, filled });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : 'No se pudo escribir en la página' },
      { status: 502 }
    );
  }
}
