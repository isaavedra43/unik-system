import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { listCaseEvents } from '@/modules/operations/events-service';
import { AI_TURN_EVENT_TYPES } from '@/modules/operations/types';
import { formatTimelineLine } from '@/modules/agents/templates';
import { foldCaseState, replayTimestamps, type ReplayEvent } from '@/modules/control-tower/replay';
import {
  controlTowerErrorResponse,
  dateParam,
  intParam,
  resolveControlTowerRoute,
} from '../../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tope de eventos que entran en una reproducción (un expediente sano tiene decenas). */
const MAX_EVENTS = 1_000;

/**
 * Reproducción de un expediente (plan 7.8d).
 *
 * Devuelve la cronología en español (`formatTimelineLine`, SIN los eventos de
 * auditoría de la IA) y el estado reconstruido con `foldCaseState` al instante
 * `?at=`: fase, pasos, work items, solicitudes e incidencias tal como estaban.
 * El estado NO se guarda en ningún lado: sale de los hechos, que es lo que
 * permite rebobinar sin fotos previas.
 */
export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const { caseId } = await params;
  const search = new URL(request.url).searchParams;
  try {
    const opCase = await prisma.operationalCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        caseNumber: true,
        customerName: true,
        salesOrderNumber: true,
        status: true,
        phase: true,
        openedAt: true,
        closedAt: true,
        promisedAt: true,
        ownerUserId: true,
      },
    });
    if (!opCase) {
      return NextResponse.json({ error: 'No encontramos ese expediente' }, { status: 404 });
    }

    const limit = intParam(search, 'limit', { min: 10, max: MAX_EVENTS }) ?? MAX_EVENTS;
    const page = await listCaseEvents(caseId, { limit, excludeTypes: AI_TURN_EVENT_TYPES });
    const events: ReplayEvent[] = page.events.map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      areaKey: event.areaKey,
      actorType: event.actorType,
      actorId: event.actorId,
      objectType: event.objectType,
      objectId: event.objectId,
      payload: event.payload,
    }));

    const at = dateParam(search, 'at');
    const state = foldCaseState(events, at);

    return NextResponse.json({
      case: {
        ...opCase,
        openedAt: opCase.openedAt.toISOString(),
        closedAt: opCase.closedAt ? opCase.closedAt.toISOString() : null,
        promisedAt: opCase.promisedAt ? opCase.promisedAt.toISOString() : null,
      },
      timeline: page.events.map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        areaKey: event.areaKey,
        actorType: event.actorType,
        actorId: event.actorId,
        // La vista del Replay pinta su propia columna de hora.
        line: formatTimelineLine(
          {
            id: event.id,
            type: event.type,
            occurredAt: event.occurredAt,
            areaKey: event.areaKey,
            actorType: event.actorType,
            payload: event.payload,
          },
          undefined,
          { withClock: false }
        ),
      })),
      timestamps: replayTimestamps(events),
      state,
      truncated: page.olderCursor !== null,
    });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
