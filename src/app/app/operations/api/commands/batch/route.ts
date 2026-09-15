import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
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
} from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST the offline queue of a device: `{deviceId, userId, commands: [≤50]}`.
 *
 * `userId` is who created the commands on the device. When it is not the
 * session user nothing is executed nor stored: every command gets
 * `actor_mismatch` and the client keeps them for their owner.
 *
 * Commands run one after another in the order received, always as the session
 * user and tagged with the batch `deviceId`. Each command gets its own result
 * (`results[i]` matches `commands[i]`, keyed by `commandId`): a malformed,
 * rejected or failed command never stops the rest. Re-sending the same batch
 * is safe — the ledger replays stored results without side effects.
 */
export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado', code: 'unauthenticated' }, { status: 401 });
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
      {
        error: envelope.error.issues[0]?.message ?? 'Lote inválido',
        code: 'invalid_request',
      },
      { status: 422 }
    );
  }
  const { deviceId, userId, commands } = envelope.data;
  if (commands.length === 0) {
    return NextResponse.json({ deviceId, results: [], summary: summarize([]) });
  }
  if (commands.length > MAX_BATCH_COMMANDS) {
    return NextResponse.json(
      {
        error: `Máximo ${MAX_BATCH_COMMANDS} comandos por lote`,
        code: 'batch_too_large',
      },
      { status: 422 }
    );
  }

  if (userId !== session.user.id) {
    console.warn(
      JSON.stringify({
        component: 'operations-command-api',
        event: 'batch_actor_mismatch',
        userId: session.user.id,
        queuedBy: userId,
        deviceId,
        commands: commands.length,
      })
    );
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
    if (parsed.data.userId && parsed.data.userId !== session.user.id) {
      results.push(actorMismatchResult(raw));
      continue;
    }
    results.push(
      await runClientCommand(toDomainCommand(parsed.data, session.user, deviceId), session.user)
    );
  }
  const summary = summarize(results);
  console.info(
    JSON.stringify({
      component: 'operations-command-api',
      event: 'batch_processed',
      userId: session.user.id,
      deviceId,
      ...summary,
    })
  );
  return NextResponse.json({ deviceId, results, summary });
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
