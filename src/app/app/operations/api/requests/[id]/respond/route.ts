import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { CommandResult } from '@/modules/operations/commands';
import {
  acceptAreaRequest,
  blockAreaRequest,
  getAreaRequest,
  rejectAreaRequest,
  resolveAreaRequest,
  type AreaRequestCommandData,
} from '@/modules/operations/area-requests-service';
import { resultHttpStatus } from '../../../commands/_shared';
import {
  jsonError,
  operationsCopilotErrorResponse,
  readCopilotJson,
  requireOperationsUser,
} from '../../../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

const reason = z
  .string({ required_error: 'Indica el motivo' })
  .trim()
  .min(3, 'Indica el motivo (mínimo 3 caracteres)')
  .max(500, 'El motivo admite hasta 500 caracteres');
/** Optional idempotency key: repeating it replays the stored result instead of deciding twice. */
const commandId = z.string().trim().min(8).max(160).optional();

const respondSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), note: z.string().trim().min(1).max(1000).optional(), commandId }),
  z.object({ action: z.literal('block'), reason, commandId }),
  z.object({
    action: z.literal('resolve'),
    answer: z
      .string({ required_error: 'Escribe la respuesta' })
      .trim()
      .min(1, 'Escribe la respuesta')
      .max(4000, 'La respuesta admite hasta 4000 caracteres'),
    commandId,
  }),
  z.object({ action: z.literal('reject'), reason, commandId }),
]);

type RespondInput = z.infer<typeof respondSchema>;

const SUCCESS_MESSAGES: Record<RespondInput['action'], string> = {
  accept: 'Solicitud aceptada',
  block: 'Solicitud bloqueada',
  resolve: 'Solicitud respondida',
  reject: 'Solicitud rechazada',
};

function runRespond(
  user: CurrentUser,
  requestId: string,
  input: RespondInput
): Promise<CommandResult<AreaRequestCommandData>> {
  const options = input.commandId ? { commandId: input.commandId } : {};
  switch (input.action) {
    case 'accept':
      return acceptAreaRequest(user, requestId, input.note ? { note: input.note } : {}, options);
    case 'block':
      return blockAreaRequest(user, requestId, { reason: input.reason }, options);
    case 'resolve':
      return resolveAreaRequest(user, requestId, { answer: input.answer }, options);
    case 'reject':
      return rejectAreaRequest(user, requestId, { reason: input.reason }, options);
  }
}

/**
 * POST { action: accept | block | resolve | reject, reason?, answer?, note? } —
 * the human responsible of the destination area decides an area request (quick
 * actions of the chat card, Mi trabajo, the area requests panel).
 *
 * Runs the core commands (`request.accept|block|resolve|reject`): they check
 * that the actor is an active human responsible (or `operations.manage`), move
 * the linked work item, emit the events and notify the other side. Rejections
 * answer `{error, code, result}` with the HTTP status of the error code.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  if (!ID_PATTERN.test(id)) return jsonError(404, 'No se encontró la solicitud', 'not_found');

  let input: RespondInput;
  try {
    const parsed = respondSchema.safeParse(await readCopilotJson(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message =
        issue?.code === 'invalid_union_discriminator' || issue?.path[0] === 'action'
          ? 'Acción inválida: usa accept, block, resolve o reject'
          : (issue?.message ?? 'Datos inválidos');
      return jsonError(400, message, 'invalid_request');
    }
    input = parsed.data;
  } catch (err) {
    return operationsCopilotErrorResponse(err);
  }

  let result: CommandResult<AreaRequestCommandData>;
  try {
    result = await runRespond(auth.user, id, input);
  } catch (err) {
    const response = operationsCopilotErrorResponse(err);
    if (response.status !== 500) return response;
    return jsonError(500, 'No se pudo completar la acción; intenta de nuevo', 'internal_error');
  }

  const status = resultHttpStatus(result.status, result.errorCode);
  if (result.status === 'rejected') {
    return NextResponse.json(
      {
        error: result.message ?? 'No se pudo completar la acción',
        code: result.errorCode ?? 'rejected',
        result,
      },
      { status }
    );
  }

  let detail = null;
  if (result.status === 'completed') {
    try {
      detail = await getAreaRequest(auth.user, id);
    } catch {
      // The decision is done; the refreshed request is only a convenience for the UI.
      detail = null;
    }
  }
  return NextResponse.json(
    { message: SUCCESS_MESSAGES[input.action], result, request: detail },
    { status }
  );
}
