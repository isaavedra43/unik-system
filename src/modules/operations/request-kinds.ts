import { z } from 'zod';
import {
  AREA_KEYS,
  INCIDENT_SEVERITIES,
  isAreaKey,
  type AreaKey,
  type AreaRequestKind,
  type Priority,
} from './types';

/**
 * Single catalog of requests between areas (plan section 5.3). Every
 * `AreaRequest` is validated here before the engine creates it: the kind must
 * exist, the origin→destination pair must be allowed and the payload must
 * match the kind's schema. `freeText` is the only unstructured field (≤800
 * characters) and is always treated as untrusted by the agents layer.
 *
 * Lives in the operations core so the engine does not depend on the agents
 * layer; the agents layer reuses it. Pure module (Zod only).
 */

export const FREE_TEXT_MAX = 800;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** ISO date (YYYY-MM-DD) or ISO date-time. */
const isoDate = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
    { message: 'Fecha inválida (usa formato ISO)' }
  );

/** Positive finite quantity; numeric strings (Decimal.toString()) are accepted. */
const quantity = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^-?\d+(\.\d+)?$/),
  ])
  .transform((value) => Number(value))
  .pipe(z.number().finite().positive());

const nonNegative = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^-?\d+(\.\d+)?$/),
  ])
  .transform((value) => Number(value))
  .pipe(z.number().finite().min(0));

const id = text(120);
const sku = text(120);
const unit = text(40);
const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Moneda inválida (ISO 4217)')
  .default('MXN');

const itemLine = z.object({ sku, qty: quantity, unit });

export const AREA_REQUEST_PAYLOAD_SCHEMAS = {
  availability_check: z.object({
    lines: z.array(itemLine).min(1).max(200),
    neededBy: isoDate,
    customerName: text(200),
  }),
  purchase_shortfall: z.object({
    demandId: id,
    allocationId: id.optional(),
    sku,
    productName: text(300),
    missingQty: quantity,
    unit,
    neededBy: isoDate,
    suggestedVendorId: id.optional(),
  }),
  direct_delivery: z.object({
    demandId: id,
    allocationId: id.optional(),
    sku,
    productName: text(300),
    missingQty: quantity,
    unit,
    neededBy: isoDate,
    suggestedVendorId: id.optional(),
  }),
  payment_authorization: z.object({
    procurementOrderId: id.optional(),
    vendorId: id,
    vendorName: text(200),
    amount: quantity,
    currency,
    dueDate: isoDate,
    reason: text(500),
  }),
  vendor_pickup: z.object({
    procurementOrderId: id,
    vendorId: id,
    pickupAddress: text(500),
    readyAt: isoDate,
    items: z.array(itemLine).min(1).max(200),
    weightKg: quantity.optional(),
  }),
  transformation: z.object({
    sourceSku: sku,
    targetSku: sku,
    qty: quantity,
    unit,
    dueAt: isoDate,
    spec: optionalText(1000),
  }),
  material_shortfall: z.object({
    productionOrderId: id,
    sku,
    missingQty: quantity,
    unit,
    neededBy: isoDate,
  }),
  finished_goods: z.object({
    productionOrderId: id,
    sku,
    qty: quantity,
    unit,
    location: text(200),
    qualityNote: optionalText(500),
  }),
  delivery_update: z.object({
    packageId: id,
    status: z.enum(['delivered', 'failed', 'partial']),
    deliveredAt: isoDate.optional(),
    evidenceLinkId: id.optional(),
    incidentId: id.optional(),
  }),
  create_package_in_zoho: z.object({
    caseId: id,
    zohoSalesOrderId: id,
    lines: z
      .array(
        z.object({
          lineRef: id,
          sku: sku.optional(),
          name: text(300),
          qty: quantity,
          unit: unit.optional(),
        })
      )
      .min(1)
      .max(200),
  }),
  resolve_difference: z.object({
    goodsReceiptId: id,
    lines: z
      .array(
        z.object({
          sku,
          ordered: nonNegative,
          received: nonNegative,
          kind: z.enum(['short', 'over', 'damaged', 'wrong_item']),
        })
      )
      .min(1)
      .max(200),
  }),
  customer_notice: z.object({
    caseId: id,
    reason: text(500),
    newEta: isoDate.optional(),
  }),
  cancel: z.object({
    allocationId: id,
    reason: text(500),
  }),
  escalation: z.object({
    reason: text(500),
    blockedSinceAt: isoDate,
    blockingAreaKey: z.enum(AREA_KEYS),
    requestId: id.optional(),
    incidentId: id.optional(),
    severity: z.enum(INCIDENT_SEVERITIES),
  }),
  info: z.object({
    question: text(FREE_TEXT_MAX),
  }),
} satisfies Record<AreaRequestKind, z.ZodTypeAny>;

export type AreaRequestPayload<K extends AreaRequestKind> = z.output<
  (typeof AREA_REQUEST_PAYLOAD_SCHEMAS)[K]
>;

/** `'*'` = any area. */
type AreaSet = readonly AreaKey[] | '*';

export interface AreaRequestKindDefinition {
  kind: AreaRequestKind;
  label: string;
  from: AreaSet;
  to: AreaSet;
  /** Default of `AreaRequest.blocksDelivery`. */
  blocksDelivery: boolean;
  defaultPriority: Priority;
  /** `info` always carries a question in free text. */
  requiresFreeText: boolean;
}

/** Areas that execute work and can therefore receive a `cancel`. */
export const EXECUTING_AREAS: readonly AreaKey[] = [
  'compras',
  'manufactura',
  'inventario',
  'logistica',
  'contabilidad',
];

export const AREA_REQUEST_KIND_CATALOG: Record<AreaRequestKind, AreaRequestKindDefinition> = {
  availability_check: {
    kind: 'availability_check',
    label: 'Verificar disponibilidad',
    from: ['ventas'],
    to: ['inventario'],
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  purchase_shortfall: {
    kind: 'purchase_shortfall',
    label: 'Faltante para compra',
    from: ['inventario'],
    to: ['compras'],
    blocksDelivery: true,
    defaultPriority: 'high',
    requiresFreeText: false,
  },
  direct_delivery: {
    kind: 'direct_delivery',
    label: 'Entrega directa del proveedor',
    from: ['inventario'],
    to: ['compras'],
    blocksDelivery: true,
    defaultPriority: 'high',
    requiresFreeText: false,
  },
  payment_authorization: {
    kind: 'payment_authorization',
    label: 'Autorización de pago',
    from: ['compras'],
    to: ['contabilidad'],
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  vendor_pickup: {
    kind: 'vendor_pickup',
    label: 'Recolección con proveedor',
    from: ['compras'],
    to: ['logistica'],
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  transformation: {
    kind: 'transformation',
    label: 'Transformación de material',
    from: ['inventario'],
    to: ['manufactura'],
    blocksDelivery: true,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  material_shortfall: {
    kind: 'material_shortfall',
    label: 'Faltante de materia prima',
    from: ['manufactura'],
    to: ['compras'],
    blocksDelivery: true,
    defaultPriority: 'high',
    requiresFreeText: false,
  },
  finished_goods: {
    kind: 'finished_goods',
    label: 'Producto terminado',
    from: ['manufactura'],
    to: ['inventario'],
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  delivery_update: {
    kind: 'delivery_update',
    label: 'Actualización de entrega',
    from: ['logistica'],
    to: ['ventas'],
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  create_package_in_zoho: {
    kind: 'create_package_in_zoho',
    label: 'Crear paquete en Zoho',
    from: ['logistica'],
    to: ['ventas'],
    blocksDelivery: true,
    defaultPriority: 'high',
    requiresFreeText: false,
  },
  resolve_difference: {
    kind: 'resolve_difference',
    label: 'Resolver diferencia de recepción',
    // Goods are received at the warehouse (inventario) or on a direct delivery (logistica).
    from: ['inventario', 'logistica'],
    to: ['compras'],
    blocksDelivery: false,
    defaultPriority: 'high',
    requiresFreeText: false,
  },
  customer_notice: {
    kind: 'customer_notice',
    label: 'Aviso al cliente',
    from: '*',
    to: ['ventas'],
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: false,
  },
  cancel: {
    kind: 'cancel',
    label: 'Cancelación',
    from: '*',
    to: EXECUTING_AREAS,
    blocksDelivery: false,
    defaultPriority: 'high',
    requiresFreeText: false,
  },
  escalation: {
    kind: 'escalation',
    label: 'Escalación',
    from: '*',
    to: ['administracion'],
    blocksDelivery: false,
    defaultPriority: 'urgent',
    requiresFreeText: false,
  },
  info: {
    kind: 'info',
    label: 'Pregunta a otra área',
    from: '*',
    to: '*',
    blocksDelivery: false,
    defaultPriority: 'normal',
    requiresFreeText: true,
  },
};

export function isAreaRequestKind(value: unknown): value is AreaRequestKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AREA_REQUEST_KIND_CATALOG, value)
  );
}

function inSet(set: AreaSet, area: AreaKey): boolean {
  return set === '*' || set.includes(area);
}

/** Pure check of the origin→destination pair (same-area requests are never allowed). */
export function isAllowedAreaPair(kind: AreaRequestKind, from: AreaKey, to: AreaKey): boolean {
  if (from === to) return false;
  const def = AREA_REQUEST_KIND_CATALOG[kind];
  return inSet(def.from, from) && inSet(def.to, to);
}

/** Destinations a given origin can send a kind to (for pickers and AI tools). */
export function allowedTargets(kind: AreaRequestKind, from: AreaKey): AreaKey[] {
  return AREA_KEYS.filter((to) => isAllowedAreaPair(kind, from, to));
}

export type AreaRequestValidationCode =
  | 'unknown_kind'
  | 'invalid_area'
  | 'pair_not_allowed'
  | 'invalid_payload'
  | 'free_text_too_long'
  | 'free_text_required';

export interface AreaRequestIssue {
  path: string;
  message: string;
}

export type AreaRequestValidation =
  | {
      ok: true;
      kind: AreaRequestKind;
      fromAreaKey: AreaKey;
      toAreaKey: AreaKey;
      payload: Record<string, unknown>;
      freeText: string | null;
      blocksDelivery: boolean;
      defaultPriority: Priority;
      label: string;
    }
  | {
      ok: false;
      code: AreaRequestValidationCode;
      message: string;
      issues: AreaRequestIssue[];
    };

/** Collapses whitespace-only text to null; keeps line breaks. */
export function normalizeFreeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[ --]/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Validates a request before the engine creates it. Returns the parsed payload
 * (Zod output: trimmed strings, numeric quantities, default currency) or the
 * first failing rule with a Spanish message.
 */
export function validateAreaRequest(
  kind: string,
  from: string,
  to: string,
  payload: unknown,
  freeText?: string | null
): AreaRequestValidation {
  if (!isAreaRequestKind(kind)) {
    return {
      ok: false,
      code: 'unknown_kind',
      message: `Tipo de solicitud desconocido: "${kind}"`,
      issues: [],
    };
  }
  if (!isAreaKey(from) || !isAreaKey(to)) {
    return {
      ok: false,
      code: 'invalid_area',
      message: 'Área de origen o destino inválida',
      issues: [],
    };
  }
  const def = AREA_REQUEST_KIND_CATALOG[kind];
  if (!isAllowedAreaPair(kind, from, to)) {
    return {
      ok: false,
      code: 'pair_not_allowed',
      message: `Una solicitud "${def.label}" no puede ir de ${from} a ${to}`,
      issues: [],
    };
  }
  const text = normalizeFreeText(freeText);
  if (text !== null && text.length > FREE_TEXT_MAX) {
    return {
      ok: false,
      code: 'free_text_too_long',
      message: `El texto libre admite hasta ${FREE_TEXT_MAX} caracteres`,
      issues: [{ path: 'freeText', message: `Máximo ${FREE_TEXT_MAX} caracteres` }],
    };
  }
  if (def.requiresFreeText && text === null) {
    return {
      ok: false,
      code: 'free_text_required',
      message: 'Esta solicitud necesita un texto que explique la pregunta',
      issues: [{ path: 'freeText', message: 'Requerido' }],
    };
  }
  const parsed = AREA_REQUEST_PAYLOAD_SCHEMAS[kind].safeParse(payload ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return {
      ok: false,
      code: 'invalid_payload',
      message: `Datos incompletos o inválidos para "${def.label}": ${issues
        .slice(0, 3)
        .map((i) => (i.path ? `${i.path} (${i.message})` : i.message))
        .join('; ')}`,
      issues,
    };
  }
  return {
    ok: true,
    kind,
    fromAreaKey: from,
    toAreaKey: to,
    payload: parsed.data as Record<string, unknown>,
    freeText: text,
    blocksDelivery: def.blocksDelivery,
    defaultPriority: def.defaultPriority,
    label: def.label,
  };
}
