import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { currentVenueSession } from '@/modules/venues/venue-manager';
import { approvePlaybook, sanitizeSteps, savePlaybook } from '@/modules/venues/venue-playbooks';
import { json, metaOf, requireVenueUser, teachOf } from '@/modules/venues/venue-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum(['start', 'save', 'discard']),
  name: z.string().min(3).max(120).optional(),
});

/**
 * POST /app/assistant/api/venue/teach — "Enséñale": the agent learns by
 * watching. `start` records every action the user does in the live browser
 * (as element selectors + text); `save` turns the recording into an ACTIVE
 * playbook (the user demonstrated it, so no extra approval) that agents and
 * routines replay with runVenuePlaybook; `discard` drops it.
 */
export async function POST(request: NextRequest) {
  const auth = await requireVenueUser('browser.use');
  if ('response' in auth) return auth.response;
  const { user } = auth;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Datos inválidos' }, 400);

  const vs = await currentVenueSession(user.id);
  if (!vs) return json({ error: 'Enciende la computadora virtual primero.' }, 409);
  const meta = metaOf(vs);

  if (parsed.data.action === 'start') {
    await prisma.venueSession.update({
      where: { id: vs.id },
      data: {
        metadata: {
          ...meta,
          teach: { recording: true, startedAt: new Date().toISOString(), steps: [] },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return json({ ok: true, recording: true });
  }

  const teach = teachOf(meta);
  const clear = async () => {
    const rest = { ...meta };
    delete rest.teach;
    await prisma.venueSession.update({
      where: { id: vs.id },
      data: { metadata: rest as unknown as Prisma.InputJsonValue },
    });
  };

  if (parsed.data.action === 'discard' || !teach) {
    await clear();
    return json({ ok: true, recording: false });
  }

  const steps = sanitizeSteps(teach.steps);
  if (steps.length === 0) {
    await clear();
    return json(
      { error: 'No se grabó ningún paso — navega y haz clic en el navegador mientras grabas.' },
      400
    );
  }
  const name =
    parsed.data.name?.trim() || `Procedimiento ${new Date().toLocaleDateString('es-MX')}`;
  const params = steps.some((s) => s.text === '{{contrasena}}')
    ? { contrasena: 'Contraseña (se pide al usar el procedimiento)' }
    : {};
  const host = steps.find((s) => s.action === 'open' && s.url)?.url;
  const saved = await savePlaybook(user, {
    name,
    steps,
    params,
    requiresHost: host ? new URL(host).hostname : undefined,
  });
  await approvePlaybook(user.id, saved.id, true);
  await clear();
  return json({ ok: true, recording: false, playbookId: saved.id, steps: steps.length, name });
}
