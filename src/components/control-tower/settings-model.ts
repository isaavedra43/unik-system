import {
  ESCALATION_RUNGS,
  WORK_ITEM_KINDS,
  WORK_ITEM_KIND_LABELS,
  type EscalationRung,
  type WorkItemKind,
} from '@/modules/operations/types';
import type {
  OperationsConfig,
  OperationsConfigPatch,
} from '@/modules/operations/operations-config';

/**
 * Editor of the operations configuration (plan 7.7 `configuración`). PURE and
 * isomorphic: it runs in the browser, so it may NOT import
 * `operations-config.ts` (that module loads Prisma and `node:async_hooks`).
 *
 * The flag list and its labels are mirrored here and `settings-model.test.ts`
 * compares them against `OPS_FLAGS` / `OPS_FLAG_LABELS`, so a flag added to the
 * core can never stay invisible in this screen.
 *
 * Nothing here decides business: the patch it builds is validated AGAIN by
 * `operationsConfigPatchSchema` inside `updateOperationsConfig`, which is the
 * single source of truth for what a valid configuration is.
 */

/** Mirror of `OPS_FLAGS`. Verified by the test. */
export const CT_OPS_FLAGS = [
  'salesToCase',
  'inventory',
  'logistics',
  'purchases',
  'manufacturing',
  'finance',
  'crm',
  'agents',
  'supervisor',
  'crmSalesOrderWrite',
] as const;

export type CtOpsFlag = (typeof CT_OPS_FLAGS)[number];

/** Mirror of `OPS_FLAG_LABELS`. Verified by the test. */
export const CT_OPS_FLAG_LABELS: Record<CtOpsFlag, string> = {
  salesToCase: 'Expediente automático al llegar una venta',
  inventory: 'Inventario progresivo',
  logistics: 'Logística',
  purchases: 'Compras y sourcing',
  manufacturing: 'Manufactura',
  finance: 'Contabilidad interna',
  crm: 'CRM y radar de cierre',
  agents: 'IA coordinadora por área',
  supervisor: 'Supervisor automático',
  crmSalesOrderWrite:
    'Crear órdenes de venta en Zoho desde el CRM (validar primero con la organización real)',
};

/** What each flag does, so nobody apaga algo sin saber qué deja de pasar. */
export const CT_OPS_FLAG_DESCRIPTIONS: Record<CtOpsFlag, string> = {
  salesToCase:
    'Cada orden de venta posterior a la fecha de corte abre su expediente y reparte el trabajo por áreas.',
  inventory:
    'Verificaciones de disponibilidad, reservas, conteos y confianza por artículo y ubicación.',
  logistics: 'Entregas, viajes, flotilla y el espejo de embarques con Zoho.',
  purchases: 'Requisiciones, sourcing, cotizaciones, órdenes de compra y recepciones.',
  manufacturing: 'Órdenes de producción, operaciones de piso, consumos y calidad.',
  finance: 'Gastos, obligaciones, cobranza, nómina, presupuestos y cierre del periodo.',
  crm: 'Oportunidades, embudo y señales del radar de cierre.',
  agents: 'Los coordinadores de área responden, resumen y proponen dentro de su presupuesto.',
  supervisor:
    'La revisión automática que detecta trabajo vencido, escala y destraba expedientes atorados.',
  crmSalesOrderWrite:
    'Permite escribir órdenes de venta REALES en Zoho desde el CRM. Con el mock encendido no hace falta.',
};

/** Consequence of turning a flag OFF, shown before confirming. */
export const CT_OPS_FLAG_OFF_WARNINGS: Record<CtOpsFlag, string> = {
  salesToCase:
    'Las órdenes de venta nuevas dejarán de abrir expediente: nadie recibirá el trabajo automáticamente.',
  inventory: 'Se dejarán de crear verificaciones y reservas; los expedientes esperarán sin avisar.',
  logistics: 'Las entregas dejarán de crearse y de sincronizarse con Zoho.',
  purchases: 'Las faltantes dejarán de convertirse en requisiciones de compra.',
  manufacturing: 'Las transformaciones dejarán de convertirse en órdenes de producción.',
  finance: 'Los gastos, las obligaciones y el cierre dejarán de registrarse desde la operación.',
  crm: 'El radar de cierre y las oportunidades dejarán de actualizarse.',
  agents: 'Los coordinadores de área dejarán de responder y de resumir en los chats.',
  supervisor:
    'Nadie revisará automáticamente el trabajo vencido: el escalamiento quedará en manos de las personas.',
  crmSalesOrderWrite: 'El CRM dejará de poder crear órdenes de venta reales en Zoho.',
};

export function flagOffWarning(flag: CtOpsFlag): string {
  return CT_OPS_FLAG_OFF_WARNINGS[flag];
}

export const ESCALATION_RUNG_LABELS: Record<EscalationRung, string> = {
  backup: 'Suplente',
  area_lead: 'Líder del área',
  administracion: 'Administración',
};

export const SLA_KIND_LABELS: Record<WorkItemKind, string> = WORK_ITEM_KIND_LABELS;

export const SLA_KIND_HINTS: Record<WorkItemKind, string> = {
  action: 'Trabajo normal de un área (preparar, revisar, avisar).',
  wait: 'Espera declarada: el expediente no avanza hasta que llegue algo.',
  approval: 'Firma de una aprobación de negocio.',
  verification: 'Confirmar que hay existencia real de un artículo.',
  external_sync: 'Escritura hacia Zoho pendiente de confirmación.',
  incident_followup: 'Seguimiento de una incidencia abierta.',
};

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

export interface OperationsSettingsForm {
  isEnabled: boolean;
  /** `YYYY-MM-DD` (the input type is `date`). */
  cutoverDate: string;
  flags: Record<CtOpsFlag, boolean>;
  /** One Zoho location id per line. */
  pilotLocationIds: string;
  slaDefaults: Record<WorkItemKind, string>;
  escalationAfterMinutes: string;
  escalationLadder: EscalationRung[];
  externalSyncStaleMinutes: string;
  legacyClaimTtlDays: string;
  reservationAlertDays: string;
  provisionalVerificationMaxHours: string;
  procurementDoubleApprovalMxn: string;
  expenseAutoApproveMxn: string;
  approvalExpiryMinutes: string;
}

function isoToDateInput(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

export function toSettingsForm(config: OperationsConfig): OperationsSettingsForm {
  return {
    isEnabled: config.isEnabled,
    cutoverDate: isoToDateInput(config.cutoverDate),
    flags: Object.fromEntries(
      CT_OPS_FLAGS.map((flag) => [flag, config.flags[flag] === true])
    ) as Record<CtOpsFlag, boolean>,
    pilotLocationIds: config.pilotLocationIds.join('\n'),
    slaDefaults: Object.fromEntries(
      WORK_ITEM_KINDS.map((kind) => [kind, String(config.slaDefaults[kind] ?? 0)])
    ) as Record<WorkItemKind, string>,
    escalationAfterMinutes: config.escalation.afterMinutes.join(', '),
    escalationLadder: [...config.escalation.ladder],
    externalSyncStaleMinutes: String(config.externalSyncStaleMinutes),
    legacyClaimTtlDays: String(config.legacyClaimTtlDays),
    reservationAlertDays: String(config.reservationAlertDays),
    provisionalVerificationMaxHours: String(config.provisionalVerificationMaxHours),
    procurementDoubleApprovalMxn: String(config.approvalThresholds.procurementDoubleApprovalMxn),
    expenseAutoApproveMxn: String(config.approvalThresholds.expenseAutoApproveMxn),
    approvalExpiryMinutes: String(config.approvalExpiryMinutes),
  };
}

export interface MinutesListResult {
  ok: boolean;
  values: number[];
  error: string | null;
}

/** "0, 120, 480" → [0,120,480]; must be ascending and at most ten rungs. */
export function parseMinutesList(raw: string): MinutesListResult {
  const parts = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, values: [], error: 'Escribe al menos un tramo (por ejemplo 0, 120, 480)' };
  }
  if (parts.length > 10) {
    return { ok: false, values: [], error: 'Como máximo diez tramos' };
  }
  const values: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 525_600) {
      return { ok: false, values: [], error: `«${part}» no es un número de minutos válido` };
    }
    values.push(value);
  }
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1]) {
      return { ok: false, values: [], error: 'Los minutos deben ir de menor a mayor' };
    }
  }
  return { ok: true, values, error: null };
}

/** One id per line (commas also accepted); duplicates and blanks are dropped. */
export function parsePilotLocationIds(raw: string): {
  ok: boolean;
  values: string[];
  error: string | null;
} {
  const values = [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];
  if (values.length > 500) {
    return { ok: false, values: [], error: 'Como máximo 500 bodegas piloto' };
  }
  const tooLong = values.find((value) => value.length > 120);
  if (tooLong) {
    return { ok: false, values: [], error: `«${tooLong.slice(0, 20)}…» es demasiado largo` };
  }
  return { ok: true, values, error: null };
}

function parseIntField(
  raw: string,
  label: string,
  bounds: { min: number; max: number }
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return { ok: false, error: `${label}: escribe un entero entre ${bounds.min} y ${bounds.max}` };
  }
  return { ok: true, value };
}

function parseMoneyField(
  raw: string,
  label: string
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1e12) {
    return { ok: false, error: `${label}: escribe un importe válido en pesos` };
  }
  return { ok: true, value };
}

export type SettingsPatchResult =
  { ok: true; patch: OperationsConfigPatch } | { ok: false; errors: string[] };

const SLA_BOUNDS = { min: 0, max: 525_600 };

/**
 * Form → patch for `updateOperationsConfig`. Collects EVERY error instead of
 * stopping at the first one, so the person fixes the whole form in one pass.
 */
export function settingsFormToPatch(form: OperationsSettingsForm): SettingsPatchResult {
  const errors: string[] = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.cutoverDate) || Number.isNaN(Date.parse(form.cutoverDate))) {
    errors.push('Fecha de corte: usa una fecha válida');
  }

  const minutes = parseMinutesList(form.escalationAfterMinutes);
  if (!minutes.ok && minutes.error) errors.push(`Escalera: ${minutes.error}`);
  if (form.escalationLadder.length === 0) errors.push('Escalera: elige al menos un peldaño');

  const pilots = parsePilotLocationIds(form.pilotLocationIds);
  if (!pilots.ok && pilots.error) errors.push(`Bodegas piloto: ${pilots.error}`);

  const slaDefaults: Record<string, number> = {};
  for (const kind of WORK_ITEM_KINDS) {
    const parsed = parseIntField(form.slaDefaults[kind] ?? '', SLA_KIND_LABELS[kind], SLA_BOUNDS);
    if (parsed.ok) slaDefaults[kind] = parsed.value;
    else errors.push(parsed.error);
  }

  const externalSync = parseIntField(
    form.externalSyncStaleMinutes,
    'Minutos antes de marcar una escritura externa como atorada',
    { min: 1, max: 1440 }
  );
  if (!externalSync.ok) errors.push(externalSync.error);

  const legacyClaim = parseIntField(form.legacyClaimTtlDays, 'Días de un reclamo legado', {
    min: 1,
    max: 365,
  });
  if (!legacyClaim.ok) errors.push(legacyClaim.error);

  const reservationAlert = parseIntField(
    form.reservationAlertDays,
    'Días antes de alertar una reserva',
    { min: 1, max: 365 }
  );
  if (!reservationAlert.ok) errors.push(reservationAlert.error);

  const provisional = parseIntField(
    form.provisionalVerificationMaxHours,
    'Horas máximas de una verificación provisional',
    { min: 1, max: 8760 }
  );
  if (!provisional.ok) errors.push(provisional.error);

  const doubleApproval = parseMoneyField(
    form.procurementDoubleApprovalMxn,
    'Umbral de doble firma'
  );
  if (!doubleApproval.ok) errors.push(doubleApproval.error);

  const expenseAuto = parseMoneyField(form.expenseAutoApproveMxn, 'Umbral de gasto sin firma');
  if (!expenseAuto.ok) errors.push(expenseAuto.error);

  const approvalExpiry = parseIntField(form.approvalExpiryMinutes, 'Plazo general de aprobación', {
    min: 30,
    max: 10080,
  });
  const approvalExpiryOptions = [30, 60, 120, 360, 720, 1440, 2880, 4320, 10080];
  if (
    !approvalExpiry.ok ||
    !approvalExpiryOptions.includes((approvalExpiry as { value?: number }).value ?? -1)
  ) {
    errors.push(
      'Plazo general de aprobación: elige 30 min, 1 h, 2 h, 6 h, 12 h, 24 h, 48 h, 72 h o 7 días'
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    patch: {
      isEnabled: form.isEnabled,
      // Midday UTC keeps the chosen day stable in Mexico City time.
      cutoverDate: new Date(`${form.cutoverDate}T12:00:00.000Z`).toISOString(),
      flags: { ...form.flags },
      pilotLocationIds: pilots.values,
      slaDefaults: slaDefaults as OperationsConfigPatch['slaDefaults'],
      escalation: { afterMinutes: minutes.values, ladder: [...form.escalationLadder] },
      externalSyncStaleMinutes: (externalSync as { value: number }).value,
      legacyClaimTtlDays: (legacyClaim as { value: number }).value,
      reservationAlertDays: (reservationAlert as { value: number }).value,
      provisionalVerificationMaxHours: (provisional as { value: number }).value,
      approvalThresholds: {
        procurementDoubleApprovalMxn: (doubleApproval as { value: number }).value,
        expenseAutoApproveMxn: (expenseAuto as { value: number }).value,
      },
      approvalExpiryMinutes: (approvalExpiry as { value: number }).value,
    },
  };
}

/** Flags being switched off by this form, so the dialog can name them. */
export function flagsBeingDisabled(
  current: OperationsConfig,
  form: OperationsSettingsForm
): CtOpsFlag[] {
  return CT_OPS_FLAGS.filter((flag) => current.flags[flag] === true && form.flags[flag] === false);
}

/** True when the kill switch of the whole core is being turned off. */
export function isKillSwitchOff(current: OperationsConfig, form: OperationsSettingsForm): boolean {
  return current.isEnabled && !form.isEnabled;
}

/** Human summary of the escalation ladder ("a los 0 min al Suplente, …"). */
export function describeEscalation(
  afterMinutes: readonly number[],
  ladder: readonly EscalationRung[]
): string {
  if (ladder.length === 0) return 'Sin escalera configurada.';
  const steps = ladder.map((rung, index) => {
    const minutes = afterMinutes[index] ?? afterMinutes[afterMinutes.length - 1] ?? 0;
    const when = minutes === 0 ? 'al vencer' : `${minutes} min después`;
    return `${when} → ${ESCALATION_RUNG_LABELS[rung]}`;
  });
  return steps.join(' · ');
}

export const ESCALATION_RUNG_OPTIONS: readonly EscalationRung[] = ESCALATION_RUNGS;
