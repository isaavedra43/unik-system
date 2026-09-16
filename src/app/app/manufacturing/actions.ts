'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AuthorizationError,
  getCurrentSession,
  type CurrentUser,
} from '@/modules/auth/authorization';
import type { CommandResult } from '@/modules/operations/commands';
import { isOperationsError } from '@/modules/operations/errors';
import {
  activateBom,
  cancelProductionOrder,
  createBom,
  createTransformationOrder,
  createWorkCenter,
  finishOperation,
  inspectProductionOrder,
  pauseOperation,
  prepareProductionOrder,
  recordConsumption,
  recordOutput,
  releaseProductionOrder,
  requestScrapReview,
  reserveMaterials,
  retireBom,
  scheduleProductionOrder,
  startOperation,
  updateBomDraft,
  updateWorkCenter,
} from '@/modules/manufacturing/manufacturing-commands';
import type {
  CancelOrderInput,
  CreateTransformationOrderInput,
  PrepareOrderInput,
  ReleaseOrderInput,
  ReserveMaterialsInput,
  ScheduleOrderInput,
} from '@/modules/manufacturing/production-service';
import type {
  FinishOperationInput,
  InspectInput,
  PauseOperationInput,
  RecordConsumptionInput,
  RecordOutputInput,
  ScrapReviewInput,
  StartOperationInput,
} from '@/modules/manufacturing/production-floor-service';
import type { CreateBomInput, UpdateBomInput } from '@/modules/manufacturing/bom-service';
import type {
  CreateWorkCenterInput,
  UpdateWorkCenterInput,
} from '@/modules/manufacturing/work-centers-service';
import {
  MANUFACTURING_BOM_PATH,
  MANUFACTURING_WORK_CENTERS_PATH,
  productionOrderUrl,
} from '@/modules/manufacturing/manufacturing-types';

/**
 * Server actions of the manufacturing workspaces.
 *
 * Every one of them calls the module's OWN service function, which is the
 * uniform `fn(actor, input, {commandId})` signature that wraps `executeCommand`:
 * the same engine the API, the AI tools and the offline queue go through. No
 * business rule is restated here — permissions, state transitions, the
 * optimistic version, the events and the audit entry all happen inside the
 * command.
 */

export interface ActionResult {
  ok: boolean;
  /** Message for the toast, always in Spanish. */
  message: string;
}

const BOM_PATH = MANUFACTURING_BOM_PATH;
const CENTERS_PATH = MANUFACTURING_WORK_CENTERS_PATH;

async function requireUser(): Promise<CurrentUser> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  return session.user;
}

function failure(error: unknown): ActionResult {
  if (isOperationsError(error)) return { ok: false, message: error.message };
  if (error instanceof AuthorizationError) return { ok: false, message: error.message };
  console.error(
    JSON.stringify({
      component: 'manufacturing-actions',
      event: 'action_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  );
  return { ok: false, message: 'No pudimos completar la acción. Intenta de nuevo.' };
}

/** Runs one command and turns its result into what the UI should say. */
async function run<D>(
  execute: (actor: CurrentUser) => Promise<CommandResult<D>>,
  success: string,
  paths: string[]
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const result = await execute(user);
    for (const path of paths) revalidatePath(path);
    switch (result.status) {
      case 'completed':
      case 'accepted':
        return { ok: true, message: success };
      case 'pending_external':
        return { ok: true, message: `${success} · sincronizando` };
      case 'rejected':
        return {
          ok: false,
          message: result.message ?? 'El motor rechazó la acción en este estado.',
        };
      default:
        return {
          ok: false,
          message: result.message ?? 'No se pudo procesar la acción; se reintentará.',
        };
    }
  } catch (error) {
    return failure(error);
  }
}

const orderPaths = (productionOrderId: string) => [productionOrderUrl(productionOrderId)];

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function scheduleOrderAction(input: ScheduleOrderInput): Promise<ActionResult> {
  return run(
    (actor) => scheduleProductionOrder(actor, input),
    'Orden programada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function reserveMaterialsAction(input: ReserveMaterialsInput): Promise<ActionResult> {
  return run(
    (actor) => reserveMaterials(actor, input),
    'Materiales reservados',
    orderPaths(String(input.productionOrderId))
  );
}

export async function prepareOrderAction(input: PrepareOrderInput): Promise<ActionResult> {
  return run(
    (actor) => prepareProductionOrder(actor, input),
    'Orden preparada: Inventario surte el material',
    orderPaths(String(input.productionOrderId))
  );
}

export async function cancelOrderAction(input: CancelOrderInput): Promise<ActionResult> {
  return run(
    (actor) => cancelProductionOrder(actor, input),
    'Orden cancelada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function createTransformationOrderAction(
  input: CreateTransformationOrderInput
): Promise<ActionResult & { productionOrderId: string | null }> {
  const user = await requireUser();
  try {
    const result = await createTransformationOrder(user, input);
    const productionOrderId = result.data?.productionOrderId ?? null;
    if (productionOrderId) revalidatePath(productionOrderUrl(productionOrderId));
    if (result.status === 'completed' || result.status === 'accepted') {
      return {
        ok: true,
        message: result.data ? `Orden ${result.data.number} creada` : 'Orden creada',
        productionOrderId,
      };
    }
    return {
      ok: false,
      message: result.message ?? 'No se pudo crear la orden de producción.',
      productionOrderId: null,
    };
  } catch (error) {
    return { ...failure(error), productionOrderId: null };
  }
}

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

export async function startOperationAction(input: StartOperationInput): Promise<ActionResult> {
  return run(
    (actor) => startOperation(actor, input),
    'Operación iniciada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function pauseOperationAction(input: PauseOperationInput): Promise<ActionResult> {
  return run(
    (actor) => pauseOperation(actor, input),
    'Operación en pausa',
    orderPaths(String(input.productionOrderId))
  );
}

export async function finishOperationAction(input: FinishOperationInput): Promise<ActionResult> {
  return run(
    (actor) => finishOperation(actor, input),
    'Operación terminada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function recordConsumptionAction(
  input: RecordConsumptionInput
): Promise<ActionResult> {
  return run(
    (actor) => recordConsumption(actor, input),
    'Consumo registrado',
    orderPaths(String(input.productionOrderId))
  );
}

export async function recordOutputAction(input: RecordOutputInput): Promise<ActionResult> {
  return run(
    (actor) => recordOutput(actor, input),
    'Salida registrada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function inspectOrderAction(input: InspectInput): Promise<ActionResult> {
  return run(
    (actor) => inspectProductionOrder(actor, input),
    'Inspección registrada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function requestScrapReviewAction(input: ScrapReviewInput): Promise<ActionResult> {
  return run(
    (actor) => requestScrapReview(actor, input),
    'Revisión de merma solicitada',
    orderPaths(String(input.productionOrderId))
  );
}

export async function releaseOrderAction(input: ReleaseOrderInput): Promise<ActionResult> {
  return run(
    (actor) => releaseProductionOrder(actor, input),
    'Orden liberada',
    orderPaths(String(input.productionOrderId))
  );
}

// ---------------------------------------------------------------------------
// Work centres and bills of materials
// ---------------------------------------------------------------------------

export async function createWorkCenterAction(input: CreateWorkCenterInput): Promise<ActionResult> {
  return run((actor) => createWorkCenter(actor, input), 'Centro de trabajo creado', [CENTERS_PATH]);
}

export async function updateWorkCenterAction(input: UpdateWorkCenterInput): Promise<ActionResult> {
  return run((actor) => updateWorkCenter(actor, input), 'Centro de trabajo actualizado', [
    CENTERS_PATH,
  ]);
}

export async function createBomAction(input: CreateBomInput): Promise<ActionResult> {
  return run((actor) => createBom(actor, input), 'Lista de materiales creada', [BOM_PATH]);
}

export async function updateBomAction(input: UpdateBomInput): Promise<ActionResult> {
  return run((actor) => updateBomDraft(actor, input), 'Lista de materiales actualizada', [
    BOM_PATH,
  ]);
}

export async function activateBomAction(input: { bomId: string }): Promise<ActionResult> {
  return run((actor) => activateBom(actor, input), 'Lista activada: retira la revisión anterior', [
    BOM_PATH,
  ]);
}

export async function retireBomAction(input: {
  bomId: string;
  reason?: string;
}): Promise<ActionResult> {
  return run((actor) => retireBom(actor, input), 'Lista retirada', [BOM_PATH]);
}
