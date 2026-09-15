import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  actorMismatchResult,
  clientCommandSchema,
  invalidCommandResult,
  readJsonBody,
  runClientCommand,
  toDomainCommand,
} from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST one operational command for the signed-in user.
 * Body: `{commandId, type, aggregate: {type, id}, payload, expectedVersion?, deviceId?, occurredAt?, userId?}`.
 * `userId` (who created it on the device) must be the session user, otherwise
 * the command is not executed and the answer is 409 `actor_mismatch`.
 * Response: `{result}` with 200 (completed), 202 (pending_external / in flight),
 * 4xx (rejected, by error code) or 500 (unexpected failure, safe to retry with
 * the same commandId).
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
  const parsed = clientCommandSchema.safeParse(body.value);
  if (!parsed.success) {
    const result = invalidCommandResult(body.value, parsed.error);
    return NextResponse.json({ result }, { status: result.httpStatus });
  }
  if (parsed.data.userId && parsed.data.userId !== session.user.id) {
    const result = actorMismatchResult(body.value);
    return NextResponse.json({ result }, { status: result.httpStatus });
  }
  const result = await runClientCommand(toDomainCommand(parsed.data, session.user), session.user);
  return NextResponse.json({ result }, { status: result.httpStatus });
}
