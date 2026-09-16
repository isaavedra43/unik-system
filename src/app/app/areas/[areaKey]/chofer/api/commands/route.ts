import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getArea } from '@/modules/areas/area-registry';
import { LOGISTICS_AREA_KEY } from '@/modules/areas/logistica/logistics-view-model';
import { LOGISTICS_COMMANDS } from '@/modules/logistics/types';
import {
  MAX_BATCH_COMMANDS,
  actorMismatchResult,
  batchEnvelopeSchema,
  clientCommandSchema,
  invalidCommandResult,
  readJsonBody,
  runClientCommand,
  toDomainCommand,
  type ClientCommandResult,
} from '@/app/app/operations/api/commands/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Commands of the driver PWA (plan 6.3). Same contract as the general batch
 * endpoint — `{deviceId, userId, commands[≤50]}`, one result per `commandId`,
 * replay-safe — with a driver-sized door:
 *
 * - it only accepts the commands of a driver's day (start, arrive, deliver,
 *   fail, close and a delivery recorded without a trip);
 * - the actor is ALWAYS the session user, and the engine checks again that the
 *   person is the driver of that trip (`assertDriverOrDispatcher`), so a driver
 *   can never operate somebody else's trip through this route.
 *
 * Anything else the phone has queued travels through
 * `/app/operations/api/commands/batch`, which is what the service worker
 * replays with Background Sync.
 */

const DRIVER_COMMAND_TYPES: ReadonlySet<string> = new Set([
  LOGISTICS_COMMANDS.tripStart,
  LOGISTICS_COMMANDS.tripArriveStop,
  LOGISTICS_COMMANDS.tripCompleteStop,
  LOGISTICS_COMMANDS.tripFailStop,
  LOGISTICS_COMMANDS.tripClose,
  LOGISTICS_COMMANDS.deliveryRecord,
]);

function notAllowedResult(commandId: string, type: string): ClientCommandResult {
  return {
    commandId,
    type,
    status: 'rejected',
    errorCode: 'forbidden',
    message: 'Esta acción no se registra desde la vista de chofer',
    aggregateVersion: 0,
    emittedEventIds: [],
    createdWorkItemIds: [],
    httpStatus: 403,
  };
}

function summarize(results: ClientCommandResult[]) {
  const summary = { total: results.length, completed: 0, pending: 0, rejected: 0, failed: 0 };
  for (const result of results) {
    if (result.status === 'completed') summary.completed += 1;
    else if (result.status === 'rejected') summary.rejected += 1;
    else if (result.status === 'failed') summary.failed += 1;
    else summary.pending += 1;
  }
  return summary;
}

export async function POST(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  if (getArea(areaKey)?.key !== LOGISTICS_AREA_KEY) {
    return NextResponse.json({ error: 'Esta ruta es del área de Logística' }, { status: 404 });
  }
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado', code: 'unauthenticated' }, { status: 401 });
  }
  const { user } = session;
  if (!hasPermission(user, 'logistics.drive') && !hasPermission(user, 'logistics.dispatch')) {
    return NextResponse.json(
      { error: 'No tienes permiso para registrar entregas', code: 'forbidden' },
      { status: 403 }
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.error, code: 'invalid_request' },
      { status: body.status }
    );
  }
  const envelope = batchEnvelopeSchema.safeParse(body.value);
  if (!envelope.success) {
    return NextResponse.json(
      { error: envelope.error.issues[0]?.message ?? 'Lote inválido', code: 'invalid_request' },
      { status: 422 }
    );
  }
  const { deviceId, userId, commands } = envelope.data;
  if (commands.length === 0) {
    return NextResponse.json({ deviceId, results: [], summary: summarize([]) });
  }
  if (commands.length > MAX_BATCH_COMMANDS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_BATCH_COMMANDS} comandos por lote`, code: 'batch_too_large' },
      { status: 422 }
    );
  }
  if (userId !== user.id) {
    const results = commands.map(actorMismatchResult);
    return NextResponse.json({ deviceId, results, summary: summarize(results) });
  }

  const results: ClientCommandResult[] = [];
  for (const raw of commands) {
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success) {
      results.push(invalidCommandResult(raw, parsed.error));
      continue;
    }
    if (parsed.data.userId && parsed.data.userId !== user.id) {
      results.push(actorMismatchResult(raw));
      continue;
    }
    if (!DRIVER_COMMAND_TYPES.has(parsed.data.type)) {
      results.push(notAllowedResult(parsed.data.commandId, parsed.data.type));
      continue;
    }
    results.push(await runClientCommand(toDomainCommand(parsed.data, user, deviceId), user));
  }

  return NextResponse.json({ deviceId, results, summary: summarize(results) });
}
