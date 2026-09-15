import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  INVENTORY_ERROR_HTTP_STATUS,
  inventoryHttpStatus,
} from '@/modules/inventory/inventory-types';
import { logisticsHttpStatus } from '@/modules/logistics/logistics-helpers';
import {
  executeCommand,
  type CommandResult,
  type CommandResultStatus,
  type DomainCommand,
} from '@/modules/operations/commands';
import { httpStatusForCode } from '@/modules/operations/errors';
// Every module registers its commands through this barrel.
import '@/modules/operations/register-commands';

/**
 * Shared server logic of the command endpoints used by the UI and by the
 * offline queue (`src/lib/offline-commands.ts`):
 *
 * - `POST /app/operations/api/commands` — one command, HTTP status by outcome.
 * - `POST /app/operations/api/commands/batch` — up to 50 queued commands.
 *
 * The session is mandatory and the actor is ALWAYS the session user: any
 * `actor` sent by the client is ignored, so a device can never issue commands
 * as another person, a bot or the system. Permissions, payload validation and
 * idempotency are enforced by `executeCommand` (a repeated `commandId` replays
 * the stored result).
 *
 * The client also says WHO created the commands (`userId`, required in a batch).
 * When it is not the session user — a shared device where another person signed
 * in before the queue was sent — nothing runs and nothing is stored: every
 * command gets `actor_mismatch`, which the client keeps for its owner.
 */

export const MAX_BATCH_COMMANDS = 50;
export const MAX_BODY_BYTES = 1_000_000;

export const clientCommandSchema = z.object({
  commandId: z.string().trim().min(1).max(160),
  type: z.string().trim().min(3).max(120),
  aggregate: z.object({
    type: z.string().trim().min(1).max(60),
    id: z.string().trim().min(1).max(200),
  }),
  expectedVersion: z.number().int().min(0).optional(),
  payload: z.unknown().optional(),
  deviceId: z.string().trim().min(1).max(120).optional(),
  occurredAt: z.string().trim().max(40).optional(),
  /** User who created the command on the device; must be the session user. */
  userId: z.string().trim().min(1).max(120).optional(),
});

export type ClientCommand = z.infer<typeof clientCommandSchema>;

export const batchEnvelopeSchema = z.object({
  deviceId: z
    .string({ required_error: 'Falta el identificador del dispositivo' })
    .trim()
    .min(1, 'Falta el identificador del dispositivo')
    .max(120),
  userId: z
    .string({ required_error: 'Falta el usuario que registró los comandos' })
    .trim()
    .min(1, 'Falta el usuario que registró los comandos')
    .max(120),
  commands: z.array(z.unknown()),
});

export type ClientResultStatus = CommandResultStatus | 'failed';

export interface ClientCommandResult extends Omit<CommandResult, 'status'> {
  status: ClientResultStatus;
  /** HTTP status this outcome maps to (useful inside a batch). */
  httpStatus: number;
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-command-api', event, ...extra }));

/** HTTP status for a rejection code, including the inventory and logistics codes. */
export function rejectionHttpStatus(code: string | undefined): number {
  if (!code) return 400;
  const logistics = logisticsHttpStatus(code);
  if (logistics !== null) return logistics;
  if (Object.prototype.hasOwnProperty.call(INVENTORY_ERROR_HTTP_STATUS, code)) {
    return inventoryHttpStatus(code);
  }
  return httpStatusForCode(code);
}

export function resultHttpStatus(status: ClientResultStatus, errorCode?: string): number {
  if (status === 'completed') return 200;
  if (status === 'pending_external' || status === 'accepted') return 202;
  if (status === 'failed') return 500;
  return rejectionHttpStatus(errorCode);
}

function withHttpStatus(result: CommandResult): ClientCommandResult {
  return { ...result, httpStatus: resultHttpStatus(result.status, result.errorCode) };
}

export function toDomainCommand(
  input: ClientCommand,
  user: CurrentUser,
  deviceId?: string
): DomainCommand {
  return {
    commandId: input.commandId,
    type: input.type,
    actor: { type: 'user', id: user.id },
    aggregate: input.aggregate,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    payload: input.payload ?? {},
    ...((deviceId ?? input.deviceId) ? { deviceId: deviceId ?? input.deviceId } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

/** Runs a command; an unexpected failure becomes a retryable `failed` result instead of a 500 for the whole request. */
export async function runClientCommand(
  cmd: DomainCommand,
  user: CurrentUser
): Promise<ClientCommandResult> {
  try {
    return withHttpStatus(await executeCommand(cmd, user));
  } catch (err) {
    log('command_failed', {
      commandId: cmd.commandId,
      type: cmd.type,
      userId: user.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      commandId: cmd.commandId,
      type: cmd.type,
      status: 'failed',
      errorCode: 'internal_error',
      message: 'No se pudo procesar la acción; se reintentará automáticamente',
      aggregateVersion: 0,
      emittedEventIds: [],
      createdWorkItemIds: [],
      httpStatus: 500,
    };
  }
}

/**
 * Result for a command created by another user than the session one. It is
 * never executed nor stored in the ledger, and the client does not drop it.
 */
export function actorMismatchResult(raw: unknown): ClientCommandResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    commandId: typeof record.commandId === 'string' ? record.commandId : '',
    type: typeof record.type === 'string' ? record.type : '',
    status: 'rejected',
    errorCode: 'actor_mismatch',
    message:
      'Esta acción la registró otro usuario en este dispositivo; se enviará cuando esa persona inicie sesión',
    aggregateVersion: 0,
    emittedEventIds: [],
    createdWorkItemIds: [],
    httpStatus: 409,
  };
}

export function invalidCommandResult(raw: unknown, error: z.ZodError): ClientCommandResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const issues = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'comando'}: ${issue.message}`)
    .join('; ');
  return {
    commandId: typeof record.commandId === 'string' ? record.commandId : '',
    type: typeof record.type === 'string' ? record.type : '',
    status: 'rejected',
    errorCode: 'invalid_payload',
    message: `Comando inválido: ${issues}`,
    aggregateVersion: 0,
    emittedEventIds: [],
    createdWorkItemIds: [],
    httpStatus: 422,
  };
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

export async function readJsonBody(request: Request): Promise<JsonBody> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: 'No se pudo leer la solicitud' };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'La solicitud es demasiado grande' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'JSON inválido' };
  }
}
