'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  AuthorizationError,
  getCurrentSession,
  hasAnyPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import {
  adjustStock,
  blockStockQuantity,
  claimLegacyStock,
  confirmLegacyStockClaim,
  createInventoryWarehouse,
  createStorageLocation,
  decideStockCountAdjustment,
  moveStock,
  releaseLegacyStockClaim,
  resolveStockCountDispute,
  unblockStockQuantity,
  updateInventoryProfile,
  updateInventoryWarehouse,
  updateStorageLocation,
  type DecideAdjustmentData,
} from '@/modules/inventory/inventory-commands';
import {
  LEGACY_CLAIM_SOURCES,
  LOCATION_KINDS,
  TRACKING_POLICIES,
} from '@/modules/inventory/inventory-types';
import { ALLOCATION_SOURCES } from '@/modules/operations/types';
import type { CommandResult } from '@/modules/operations/commands';
import {
  ADJUSTMENT_DECISIONS,
  DECISION_NOTE_MAX,
  DISPUTE_DECISIONS,
  INVENTORY_BASE_PATH,
  STOCK_ACTION_KINDS,
  describeAdjustmentOutcome,
} from '@/components/areas/inventario/inventario-model';

/**
 * Server actions of the Inventario management pages and panels (perfiles,
 * ubicaciones, diferencias de conteo, movimientos y reclamos legados).
 *
 * They do NOT implement business rules: every one of them calls the module's
 * own command wrapper (`@/modules/inventory/inventory-commands`), which goes
 * through `executeCommand` with its permission, its Zod schema and its
 * optimistic version. Here we only read the form, check the person may manage
 * inventory and turn the result into a message in Spanish.
 *
 * The permission checked here is the SAME key the command demands inside the
 * transaction (`inventory.adjust` for adjustments and blocks, `inventory.manage`
 * for physical movements, `inventory.reserve` for legacy claims): this only
 * saves a round trip, it never grants anything.
 */

export interface InventoryFormState {
  error: string | null;
  success: boolean;
  message: string | null;
}

export const EMPTY_FORM_STATE: InventoryFormState = {
  error: null,
  success: false,
  message: null,
};

const MANAGE_PERMISSIONS = ['inventory.manage'] as const;

async function requireAny(permissions: readonly string[], message: string): Promise<CurrentUser> {
  const session = await getCurrentSession();
  if (!session) throw new AuthorizationError('Tu sesión expiró; vuelve a iniciar sesión');
  if (!hasAnyPermission(session.user, [...permissions])) {
    throw new AuthorizationError(message);
  }
  return session.user;
}

function requireManager(): Promise<CurrentUser> {
  return requireAny(MANAGE_PERMISSIONS, 'No tienes permiso para configurar el inventario');
}

function failure(error: unknown): InventoryFormState {
  const message =
    error instanceof AuthorizationError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'No pudimos guardar los cambios';
  return { error: message, success: false, message: null };
}

/** Turns a command result into the state the form renders. */
function fromResult(result: CommandResult<unknown>, message: string): InventoryFormState {
  if (result.status === 'completed' || result.status === 'accepted') {
    return { error: null, success: true, message };
  }
  return {
    error: result.message ?? 'El motor rechazó el cambio; revisa los datos e intenta de nuevo.',
    success: false,
    message: null,
  };
}

function refresh(path: string): void {
  revalidatePath(path);
}

// ---------------------------------------------------------------------------
// Product profile
// ---------------------------------------------------------------------------

const conversionSchema = z.object({
  unit: z.string().trim().min(1).max(30),
  factor: z.string().trim().min(1).max(30),
});

const profileSchema = z.object({
  profileId: z.string().trim().min(1),
  zohoItemId: z.string().trim().min(1),
  version: z.coerce.number().int().min(1),
  baseUnit: z.string().trim().min(1).max(30),
  tolerancePct: z.coerce.number().finite().min(0).max(100),
  trackingPolicy: z.enum(TRACKING_POLICIES),
  defaultSource: z.enum(ALLOCATION_SOURCES),
  isBulk: z.coerce.boolean(),
  variantAxes: z.array(z.string().trim().min(1).max(30)).max(6),
  conversions: z.array(conversionSchema).max(12),
  weightKgPerBaseUnit: z.number().finite().min(0).nullable(),
  areaM2PerBaseUnit: z.number().finite().min(0).nullable(),
});

export type ProfilePatchInput = z.input<typeof profileSchema>;

/**
 * Saves the inventory profile of an item (unidad base, conversiones,
 * tolerancia, variables, política de rastreo y fuente por defecto).
 */
export async function saveProfileAction(
  _prevState: InventoryFormState,
  input: ProfilePatchInput
): Promise<InventoryFormState> {
  try {
    const actor = await requireManager();
    const parsed = profileSchema.safeParse(input);
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Revisa los datos del perfil',
        success: false,
        message: null,
      };
    }
    const { profileId, zohoItemId, version, ...patch } = parsed.data;
    const result = await updateInventoryProfile(
      actor,
      { profileId, ...patch },
      { expectedVersion: version }
    );
    refresh(`${INVENTORY_BASE_PATH}/perfiles/${encodeURIComponent(zohoItemId)}`);
    return fromResult(result, 'Perfil actualizado');
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Warehouses and locations
// ---------------------------------------------------------------------------

const createWarehouseSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre de la bodega').max(120),
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Clave inválida: minúsculas, números y guiones')
    .optional()
    .or(z.literal('')),
});

export async function createWarehouseAction(
  _prevState: InventoryFormState,
  formData: FormData
): Promise<InventoryFormState> {
  try {
    const actor = await requireManager();
    const parsed = createWarehouseSchema.safeParse({
      name: formData.get('name') ?? '',
      key: formData.get('key') ?? '',
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Revisa los datos de la bodega',
        success: false,
        message: null,
      };
    }
    const result = await createInventoryWarehouse(actor, {
      name: parsed.data.name,
      ...(parsed.data.key ? { key: parsed.data.key } : {}),
    });
    refresh(`${INVENTORY_BASE_PATH}/ubicaciones`);
    return fromResult(result, 'Bodega creada con su ubicación GENERAL');
  } catch (error) {
    return failure(error);
  }
}

const updateWarehouseSchema = z.object({
  warehouseId: z.string().trim().min(1),
  name: z.string().trim().min(1, 'Escribe el nombre de la bodega').max(120),
  active: z.boolean(),
});

export async function updateWarehouseAction(
  _prevState: InventoryFormState,
  formData: FormData
): Promise<InventoryFormState> {
  try {
    const actor = await requireManager();
    const parsed = updateWarehouseSchema.safeParse({
      warehouseId: formData.get('warehouseId') ?? '',
      name: formData.get('name') ?? '',
      active: formData.get('active') === 'true',
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Revisa los datos de la bodega',
        success: false,
        message: null,
      };
    }
    const result = await updateInventoryWarehouse(actor, parsed.data);
    refresh(`${INVENTORY_BASE_PATH}/ubicaciones`);
    return fromResult(result, 'Bodega actualizada');
  } catch (error) {
    return failure(error);
  }
}

const createLocationSchema = z.object({
  warehouseId: z.string().trim().min(1, 'Elige la bodega'),
  code: z.string().trim().min(1, 'Escribe el código').max(40),
  label: z.string().trim().max(120).optional().or(z.literal('')),
  kind: z.enum(LOCATION_KINDS),
});

export async function createLocationAction(
  _prevState: InventoryFormState,
  formData: FormData
): Promise<InventoryFormState> {
  try {
    const actor = await requireManager();
    const parsed = createLocationSchema.safeParse({
      warehouseId: formData.get('warehouseId') ?? '',
      code: formData.get('code') ?? '',
      label: formData.get('label') ?? '',
      kind: formData.get('kind') ?? 'rack',
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Revisa los datos de la ubicación',
        success: false,
        message: null,
      };
    }
    const result = await createStorageLocation(actor, {
      warehouseId: parsed.data.warehouseId,
      code: parsed.data.code,
      kind: parsed.data.kind,
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
    });
    refresh(`${INVENTORY_BASE_PATH}/ubicaciones`);
    return fromResult(result, 'Ubicación creada');
  } catch (error) {
    return failure(error);
  }
}

const updateLocationSchema = z.object({
  locationId: z.string().trim().min(1),
  label: z.string().trim().max(120).optional().or(z.literal('')),
  kind: z.enum(LOCATION_KINDS),
  active: z.boolean(),
});

export async function updateLocationAction(
  _prevState: InventoryFormState,
  formData: FormData
): Promise<InventoryFormState> {
  try {
    const actor = await requireManager();
    const parsed = updateLocationSchema.safeParse({
      locationId: formData.get('locationId') ?? '',
      label: formData.get('label') ?? '',
      kind: formData.get('kind') ?? 'rack',
      active: formData.get('active') === 'true',
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Revisa los datos de la ubicación',
        success: false,
        message: null,
      };
    }
    const result = await updateStorageLocation(actor, {
      locationId: parsed.data.locationId,
      label: parsed.data.label ? parsed.data.label : null,
      kind: parsed.data.kind,
      active: parsed.data.active,
    });
    refresh(`${INVENTORY_BASE_PATH}/ubicaciones`);
    return fromResult(result, 'Ubicación actualizada');
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Panels: typed result instead of a form state
// ---------------------------------------------------------------------------

/**
 * The management panels (diferencias de conteo, movimientos, reclamos) are not
 * `useActionState` forms: they show what the engine answered, so they get the
 * data back instead of a message only.
 */
export type InventoryActionResult<T = null> =
  { ok: true; data: T; message: string } | { ok: false; error: string };

function actionFailure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof AuthorizationError) return { ok: false, error: error.message };
  if (error instanceof Error && error.message) return { ok: false, error: error.message };
  return { ok: false, error: fallback };
}

/** A rejected command carries its own Spanish message; never leak a stack. */
function fromCommand<T>(
  result: CommandResult<T>,
  message: string,
  fallback: string
): InventoryActionResult<T> {
  if (result.status === 'completed' || result.status === 'accepted') {
    return { ok: true, data: (result.data ?? null) as T, message };
  }
  return { ok: false, error: result.message ?? fallback };
}

/** Everything under `/app/areas/inventario` reads stock, so the layout is refreshed. */
function refreshArea(): void {
  revalidatePath(INVENTORY_BASE_PATH, 'layout');
}

// ---------------------------------------------------------------------------
// Diferencias de conteo (plan §3.3: decisión y disputa)
// ---------------------------------------------------------------------------

const ADJUST_PERMISSIONS = ['inventory.adjust'] as const;
const ADJUST_DENIED = 'No tienes permiso para ajustar inventario';

const decideAdjustmentSchema = z
  .object({
    lineId: z.string().trim().min(1, 'Falta la línea del conteo'),
    decision: z.enum(ADJUSTMENT_DECISIONS),
    note: z.string().trim().max(DECISION_NOTE_MAX).optional(),
  })
  .strict();

/**
 * Autoriza (o rechaza) una diferencia DENTRO de tolerancia que quedó pendiente
 * porque quien cerró el conteo no podía ajustar. Aprobar mueve el libro, así
 * que pasa por la aprobación de negocio `inventory_adjustment`: con dos firmas
 * la línea sigue pendiente y el mensaje lo dice.
 */
export async function decideCountAdjustmentAction(
  input: z.input<typeof decideAdjustmentSchema>
): Promise<InventoryActionResult<DecideAdjustmentData>> {
  const parsed = decideAdjustmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Revisa la decisión' };
  }
  try {
    const actor = await requireAny(ADJUST_PERMISSIONS, ADJUST_DENIED);
    const result = await decideStockCountAdjustment(actor, parsed.data);
    const outcome = fromCommand(
      result,
      'Decisión registrada',
      'No se pudo registrar la decisión sobre la diferencia'
    );
    if (!outcome.ok) return outcome;
    refreshArea();
    return {
      ok: true,
      data: outcome.data,
      message: describeAdjustmentOutcome({
        decision: parsed.data.decision,
        awaitingApproval: outcome.data?.awaitingApproval === true,
        noApprovers: outcome.data?.noApprovers === true,
      }),
    };
  } catch (error) {
    return actionFailure(error, 'No se pudo registrar la decisión sobre la diferencia');
  }
}

const resolveDisputeSchema = z
  .object({
    lineId: z.string().trim().min(1, 'Falta la línea del conteo'),
    decision: z.enum(DISPUTE_DECISIONS),
    confirmedQty: z.string().trim().min(1).max(30).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    note: z.string().trim().min(1, 'Explica cómo se resolvió la diferencia').max(DECISION_NOTE_MAX),
  })
  .strict();

/**
 * Resuelve una línea EN DISPUTA (fuera de tolerancia). Es la única puerta que
 * devuelve el artículo a `PROVISIONAL`: mientras quede una disputa abierta el
 * perfil sigue `DISPUTED` y nada de ese SKU se puede prometer.
 */
export async function resolveCountDisputeAction(
  input: z.input<typeof resolveDisputeSchema>
): Promise<
  InventoryActionResult<{
    confidence: string;
    disputeResolved: boolean;
    movementId: string | null;
  }>
> {
  const parsed = resolveDisputeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Revisa la resolución' };
  }
  try {
    const actor = await requireAny(ADJUST_PERMISSIONS, ADJUST_DENIED);
    const { confirmedQty, unit, ...rest } = parsed.data;
    const result = await resolveStockCountDispute(actor, {
      ...rest,
      ...(confirmedQty ? { confirmedQty } : {}),
      ...(unit ? { unit } : {}),
    });
    const outcome = fromCommand(result, 'Diferencia resuelta', 'No se pudo resolver la diferencia');
    if (!outcome.ok) return outcome;
    refreshArea();
    return {
      ok: true,
      data: {
        confidence: outcome.data?.confidence ?? 'DISPUTED',
        disputeResolved: outcome.data?.disputeResolved === true,
        movementId: outcome.data?.movementId ?? null,
      },
      message: outcome.data?.disputeResolved
        ? 'Diferencia resuelta: el artículo vuelve a poder prometerse.'
        : 'Diferencia resuelta; el artículo sigue con otras disputas abiertas.',
    };
  } catch (error) {
    return actionFailure(error, 'No se pudo resolver la diferencia');
  }
}

// ---------------------------------------------------------------------------
// Movimientos capturados a mano (entradas, salidas, traspasos, ajustes, bloqueos)
// ---------------------------------------------------------------------------

const MOVE_PERMISSIONS = ['inventory.manage'] as const;
const MOVE_DENIED = 'No tienes permiso para registrar movimientos de inventario';

const stockActionSchema = z
  .object({
    kind: z.enum(STOCK_ACTION_KINDS),
    zohoItemId: z.string().trim().min(1, 'Falta el artículo'),
    warehouseId: z.string().trim().min(1, 'Falta la bodega'),
    stockItemId: z.string().trim().min(1).max(120).optional(),
    locationCode: z.string().trim().min(1).max(40).optional(),
    toWarehouseId: z.string().trim().min(1).max(120).optional(),
    toLocationCode: z.string().trim().min(1).max(40).optional(),
    quantity: z.string().trim().min(1, 'Falta la cantidad').max(30),
    unit: z.string().trim().min(1).max(30).optional(),
    reason: z.string().trim().min(1).max(DECISION_NOTE_MAX).optional(),
    reference: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export interface StockActionOutcome {
  kind: string;
  movementIds: string[];
  /** Saldo que el motor dejó (conocido para movimientos, bloqueado para bloqueos). */
  known: string | null;
  blocked: string | null;
}

/**
 * Registra el movimiento que la persona capturó. `transfer` es UN comando
 * (salida + entrada bajo la misma transacción) y `adjust` / `block` / `unblock`
 * exigen `inventory.adjust`, que es lo que el propio comando vuelve a validar.
 */
export async function recordStockActionAction(
  input: z.input<typeof stockActionSchema>
): Promise<InventoryActionResult<StockActionOutcome>> {
  const parsed = stockActionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Revisa los datos del movimiento',
    };
  }
  const values = parsed.data;
  const needsAdjust =
    values.kind === 'adjust' || values.kind === 'block' || values.kind === 'unblock';
  try {
    const actor = needsAdjust
      ? await requireAny(ADJUST_PERMISSIONS, ADJUST_DENIED)
      : await requireAny(MOVE_PERMISSIONS, MOVE_DENIED);
    const reference = values.reference
      ? { referenceType: 'manual', referenceId: values.reference }
      : {};

    if (values.kind === 'block' || values.kind === 'unblock') {
      if (!values.stockItemId) {
        return { ok: false, error: 'Elige la existencia que vas a bloquear o desbloquear' };
      }
      if (!values.reason) return { ok: false, error: 'Escribe el motivo del bloqueo' };
      const run = values.kind === 'block' ? blockStockQuantity : unblockStockQuantity;
      const result = await run(actor, {
        stockItemId: values.stockItemId,
        quantity: values.quantity,
        ...(values.unit ? { unit: values.unit } : {}),
        reason: values.reason,
      });
      const outcome = fromCommand(
        result,
        values.kind === 'block' ? 'Existencia bloqueada' : 'Existencia desbloqueada',
        'No se pudo registrar el bloqueo'
      );
      if (!outcome.ok) return outcome;
      refreshArea();
      return {
        ok: true,
        message: values.kind === 'block' ? 'Existencia bloqueada' : 'Existencia desbloqueada',
        data: {
          kind: values.kind,
          movementIds: outcome.data?.movement ? [outcome.data.movement.id] : [],
          known: null,
          blocked: outcome.data?.blocked ?? null,
        },
      };
    }

    if (values.kind === 'adjust') {
      if (!values.reason) return { ok: false, error: 'Escribe el motivo del ajuste' };
      const result = await adjustStock(actor, {
        zohoItemId: values.zohoItemId,
        warehouseId: values.warehouseId,
        ...(values.stockItemId ? { stockItemId: values.stockItemId } : {}),
        ...(values.locationCode ? { locationCode: values.locationCode } : {}),
        quantity: values.quantity,
        ...(values.unit ? { unit: values.unit } : {}),
        reason: values.reason,
      });
      const outcome = fromCommand(result, 'Ajuste registrado', 'No se pudo registrar el ajuste');
      if (!outcome.ok) return outcome;
      refreshArea();
      return {
        ok: true,
        message: 'Ajuste registrado',
        data: {
          kind: 'adjust',
          movementIds: outcome.data?.movement ? [outcome.data.movement.id] : [],
          known: outcome.data?.known ?? null,
          blocked: null,
        },
      };
    }

    if (values.kind === 'transfer') {
      if (!values.toWarehouseId) return { ok: false, error: 'Elige la bodega de destino' };
      const result = await moveStock(actor, {
        kind: 'transfer',
        zohoItemId: values.zohoItemId,
        fromWarehouseId: values.warehouseId,
        ...(values.stockItemId ? { fromStockItemId: values.stockItemId } : {}),
        ...(values.locationCode ? { fromLocationCode: values.locationCode } : {}),
        toWarehouseId: values.toWarehouseId,
        ...(values.toLocationCode ? { toLocationCode: values.toLocationCode } : {}),
        quantity: values.quantity,
        ...(values.unit ? { unit: values.unit } : {}),
        ...(values.reason ? { note: values.reason } : {}),
        ...reference,
      });
      const outcome = fromCommand(
        result,
        'Traspaso registrado',
        'No se pudo registrar el traspaso'
      );
      if (!outcome.ok) return outcome;
      refreshArea();
      return {
        ok: true,
        message: 'Traspaso registrado',
        data: {
          kind: 'transfer',
          movementIds: (outcome.data?.movements ?? []).map((movement) => movement.id),
          known: null,
          blocked: null,
        },
      };
    }

    const result = await moveStock(actor, {
      kind: values.kind,
      zohoItemId: values.zohoItemId,
      warehouseId: values.warehouseId,
      ...(values.stockItemId ? { stockItemId: values.stockItemId } : {}),
      ...(values.locationCode ? { locationCode: values.locationCode } : {}),
      quantity: values.quantity,
      ...(values.unit ? { unit: values.unit } : {}),
      ...(values.reason ? { note: values.reason } : {}),
      ...reference,
    });
    const outcome = fromCommand(
      result,
      'Movimiento registrado',
      'No se pudo registrar el movimiento'
    );
    if (!outcome.ok) return outcome;
    refreshArea();
    return {
      ok: true,
      message: 'Movimiento registrado',
      data: {
        kind: values.kind,
        movementIds: (outcome.data?.movements ?? []).map((movement) => movement.id),
        known: null,
        blocked: null,
      },
    };
  } catch (error) {
    return actionFailure(error, 'No se pudo registrar el movimiento');
  }
}

// ---------------------------------------------------------------------------
// Reclamos legados (compromisos anteriores al corte)
// ---------------------------------------------------------------------------

const CLAIM_PERMISSIONS = ['inventory.reserve'] as const;
const CLAIM_DENIED = 'No tienes permiso para reservar ni comprometer inventario';

const claimSchema = z
  .object({
    zohoItemId: z.string().trim().min(1, 'Falta el artículo'),
    warehouseId: z.string().trim().min(1, 'Falta la bodega'),
    quantity: z.string().trim().min(1, 'Falta la cantidad').max(30),
    unit: z.string().trim().min(1).max(30).optional(),
    source: z.enum(LEGACY_CLAIM_SOURCES),
    reference: z.string().trim().min(1, 'Escribe la referencia del compromiso').max(200),
    note: z.string().trim().min(1).max(DECISION_NOTE_MAX).optional(),
  })
  .strict();

export interface LegacyClaimOutcome {
  claimId: string;
  availableAfter: string;
  exceedsAvailable: boolean;
  expiresAt: string;
}

/**
 * Registra lo prometido ANTES del corte: resta del disponible hasta que se
 * confirme contra un expediente o se libere, y el supervisor lo expira por TTL.
 * Sin esta captura todo lo prometido de palabra se promete dos veces.
 */
export async function claimLegacyStockAction(
  input: z.input<typeof claimSchema>
): Promise<InventoryActionResult<LegacyClaimOutcome>> {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Revisa los datos del compromiso',
    };
  }
  try {
    const actor = await requireAny(CLAIM_PERMISSIONS, CLAIM_DENIED);
    const result = await claimLegacyStock(actor, parsed.data);
    const outcome = fromCommand(
      result,
      'Compromiso registrado',
      'No se pudo registrar el compromiso'
    );
    if (!outcome.ok) return outcome;
    refreshArea();
    return {
      ok: true,
      message: outcome.data?.exceedsAvailable
        ? 'Compromiso registrado: deja el disponible en negativo, así que se levantó una incidencia.'
        : 'Compromiso registrado: la cantidad deja de estar disponible.',
      data: {
        claimId: outcome.data?.claim.id ?? '',
        availableAfter: outcome.data?.availableAfter ?? '0',
        exceedsAvailable: outcome.data?.exceedsAvailable === true,
        expiresAt: outcome.data?.claim.expiresAt ?? '',
      },
    };
  } catch (error) {
    return actionFailure(error, 'No se pudo registrar el compromiso');
  }
}

const confirmClaimSchema = z
  .object({
    claimId: z.string().trim().min(1, 'Falta el reclamo'),
    caseId: z.string().trim().min(1, 'Falta el expediente'),
    demandId: z.string().trim().min(1, 'Falta la necesidad del expediente'),
    allowProvisional: z.boolean().default(false),
  })
  .strict();

/** Ata el compromiso a una necesidad del expediente: deja de ser reclamo y pasa a reserva. */
export async function confirmLegacyClaimAction(
  input: z.input<typeof confirmClaimSchema>
): Promise<InventoryActionResult<{ reservations: number; provisional: boolean }>> {
  const parsed = confirmClaimSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Revisa los datos de la confirmación',
    };
  }
  try {
    const actor = await requireAny(CLAIM_PERMISSIONS, CLAIM_DENIED);
    const result = await confirmLegacyStockClaim(actor, parsed.data);
    const outcome = fromCommand(
      result,
      'Compromiso confirmado',
      'No se pudo confirmar el compromiso'
    );
    if (!outcome.ok) return outcome;
    refreshArea();
    return {
      ok: true,
      message: outcome.data?.provisional
        ? 'Compromiso confirmado como reserva provisional (el artículo no está controlado).'
        : 'Compromiso confirmado: ya es una reserva del expediente.',
      data: {
        reservations: outcome.data?.reservations.length ?? 0,
        provisional: outcome.data?.provisional === true,
      },
    };
  } catch (error) {
    return actionFailure(error, 'No se pudo confirmar el compromiso');
  }
}

const releaseClaimSchema = z
  .object({
    claimId: z.string().trim().min(1, 'Falta el reclamo'),
    reason: z.string().trim().min(1, 'Di por qué se libera el compromiso').max(DECISION_NOTE_MAX),
  })
  .strict();

/** Libera el compromiso: la cantidad vuelve al disponible de inmediato. */
export async function releaseLegacyClaimAction(
  input: z.input<typeof releaseClaimSchema>
): Promise<InventoryActionResult<{ status: string }>> {
  const parsed = releaseClaimSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Revisa los datos' };
  }
  try {
    const actor = await requireAny(CLAIM_PERMISSIONS, CLAIM_DENIED);
    const result = await releaseLegacyStockClaim(actor, {
      claimId: parsed.data.claimId,
      reason: parsed.data.reason,
    });
    const outcome = fromCommand(result, 'Compromiso liberado', 'No se pudo liberar el compromiso');
    if (!outcome.ok) return outcome;
    refreshArea();
    return {
      ok: true,
      message: 'Compromiso liberado: la cantidad vuelve a estar disponible.',
      data: { status: outcome.data?.claim.status ?? 'released' },
    };
  } catch (error) {
    return actionFailure(error, 'No se pudo liberar el compromiso');
  }
}
