import { z } from 'zod';
import {
  APPROVAL_SCOPES,
  APPROVAL_SCOPE_LABELS,
  type ApprovalScope,
} from '@/modules/operations/types';

/**
 * Approval policies by scope, category, amount range, signatures and roles
 * (plan 7.7 `configuración`, model `ApprovalPolicy`). PURE and isomorphic: the
 * form, the server action and the tests share one schema.
 *
 * The RULE that picks a policy is NOT here: `selectApprovalPolicy` /
 * `resolveApprovalRequirement` (approvals-service) already own it, and the
 * preview of this screen calls them so what the editor promises is exactly what
 * the engine would do.
 */

export const APPROVAL_POLICY_SCOPES: readonly ApprovalScope[] = APPROVAL_SCOPES;
export const APPROVAL_POLICY_SCOPE_LABELS: Record<ApprovalScope, string> = APPROVAL_SCOPE_LABELS;

/** What each scope covers, so nobody escribe una política en el alcance equivocado. */
export const APPROVAL_POLICY_SCOPE_HINTS: Record<ApprovalScope, string> = {
  expense: 'Gastos capturados en Contabilidad (tickets, viáticos, servicios).',
  procurement: 'Órdenes de compra a proveedores.',
  payment: 'Autorización de pago de una obligación.',
  payroll: 'Corridas de nómina.',
  production_incident: 'Incidencias de producción que piden una decisión (merma, retrabajo).',
  inventory_adjustment:
    'Ajustes de inventario que cambian existencias: las diferencias de conteo que Inventario autoriza. Con una firma decide quien tiene «Ajustar inventario»; desde dos, el ajuste espera las firmas y sólo entonces se aplica.',
};

export const POLICY_CURRENCIES = ['MXN', 'USD'] as const;
export type PolicyCurrency = (typeof POLICY_CURRENCIES)[number];

/** Row as it travels from the server (amounts already serialized as strings). */
export interface ApprovalPolicyRow {
  id: string;
  scope: ApprovalScope;
  categoryId: string | null;
  categoryLabel: string | null;
  minAmount: string;
  maxAmount: string | null;
  currency: string;
  requiredApprovals: number;
  /** null = use the general deadline configured in Operations. */
  expiresAfterMinutes: number | null;
  approverRoleKeys: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

const amountField = z
  .string()
  .trim()
  .max(24)
  .refine((value) => value === '' || (Number.isFinite(Number(value)) && Number(value) >= 0), {
    message: 'Escribe un importe válido (0 o más)',
  });

export const approvalPolicyFormSchema = z
  .object({
    scope: z.enum(APPROVAL_SCOPES),
    categoryId: z.string().trim().max(120).optional().default(''),
    minAmount: amountField.default('0'),
    /** Empty = sin tope superior. */
    maxAmount: amountField.default(''),
    currency: z.enum(POLICY_CURRENCIES).default('MXN'),
    requiredApprovals: z.coerce.number().int().min(0).max(5),
    expiresAfterMinutes: z.coerce
      .number()
      .int()
      .refine((value) => [0, 30, 60, 120, 360, 720, 1440, 2880, 4320, 10080].includes(value), {
        message: 'Elige un plazo permitido',
      })
      .default(0),
    approverRoleKeys: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    const min = Number(value.minAmount === '' ? '0' : value.minAmount);
    if (value.maxAmount !== '') {
      const max = Number(value.maxAmount);
      if (max <= min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['maxAmount'],
          message: 'El tope debe ser mayor que el mínimo',
        });
      }
    }
  });

export type ApprovalPolicyFormInput = z.input<typeof approvalPolicyFormSchema>;
export type ApprovalPolicyForm = z.output<typeof approvalPolicyFormSchema>;

export const EMPTY_POLICY_FORM: ApprovalPolicyFormInput = {
  scope: 'expense',
  categoryId: '',
  minAmount: '0',
  maxAmount: '',
  currency: 'MXN',
  requiredApprovals: 1,
  expiresAfterMinutes: 0,
  approverRoleKeys: [],
  active: true,
};

export function policyToForm(row: ApprovalPolicyRow): ApprovalPolicyFormInput {
  return {
    scope: row.scope,
    categoryId: row.categoryId ?? '',
    minAmount: row.minAmount,
    maxAmount: row.maxAmount ?? '',
    currency: (POLICY_CURRENCIES as readonly string[]).includes(row.currency)
      ? (row.currency as PolicyCurrency)
      : 'MXN',
    requiredApprovals: row.requiredApprovals,
    expiresAfterMinutes: row.expiresAfterMinutes ?? 0,
    approverRoleKeys: [...row.approverRoleKeys],
    active: row.active,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function formatPolicyAmount(value: string | number, currency: string): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return `${value} ${currency}`;
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString('es-MX')} ${currency}`;
  }
}

/** "De $0 a $50,000" / "Desde $50,000". Ranges are `[min, max)`. */
export function policyRangeLabel(
  minAmount: string | number,
  maxAmount: string | number | null,
  currency: string
): string {
  const min = formatPolicyAmount(minAmount, currency);
  if (maxAmount === null || maxAmount === '') return `Desde ${min}`;
  return `De ${min} a ${formatPolicyAmount(maxAmount, currency)}`;
}

export function describeRequiredSignatures(count: number): string {
  if (count <= 0) return 'Se aprueba solo (sin firma)';
  if (count === 1) return 'Una firma';
  return `${count} firmas distintas`;
}

/** Order shown in the table: scope, then currency, then amount. */
export function sortPolicies(rows: readonly ApprovalPolicyRow[]): ApprovalPolicyRow[] {
  const scopeIndex = (scope: ApprovalScope) => APPROVAL_SCOPES.indexOf(scope);
  return [...rows].sort(
    (a, b) =>
      scopeIndex(a.scope) - scopeIndex(b.scope) ||
      a.currency.localeCompare(b.currency) ||
      Number(a.minAmount) - Number(b.minAmount)
  );
}

function rangesOverlap(a: ApprovalPolicyRow, b: ApprovalPolicyRow): boolean {
  const aMin = Number(a.minAmount);
  const aMax = a.maxAmount === null ? Number.POSITIVE_INFINITY : Number(a.maxAmount);
  const bMin = Number(b.minAmount);
  const bMax = b.maxAmount === null ? Number.POSITIVE_INFINITY : Number(b.maxAmount);
  return aMin < bMax && bMin < aMax;
}

/**
 * Warnings the editor shows: two active rows of the same scope, category and
 * currency whose ranges overlap. The engine still answers (the most specific
 * rule with the highest minimum wins), but the person should know.
 */
export function overlappingPolicyWarnings(rows: readonly ApprovalPolicyRow[]): string[] {
  const active = rows.filter((row) => row.active);
  const warnings: string[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (a.scope !== b.scope) continue;
      if ((a.categoryId ?? '') !== (b.categoryId ?? '')) continue;
      if (a.currency !== b.currency) continue;
      if (!rangesOverlap(a, b)) continue;
      warnings.push(
        `${APPROVAL_POLICY_SCOPE_LABELS[a.scope]}: ${policyRangeLabel(a.minAmount, a.maxAmount, a.currency)} se encima con ${policyRangeLabel(b.minAmount, b.maxAmount, b.currency)}. Gana la de mínimo más alto.`
      );
    }
  }
  return warnings;
}

/** Scopes without a single active row use the defaults of the operations config. */
export function scopesUsingDefaults(rows: readonly ApprovalPolicyRow[]): ApprovalScope[] {
  return APPROVAL_SCOPES.filter((scope) => !rows.some((row) => row.scope === scope && row.active));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Answer of "¿a quién le pediría firma esta política?" (server computed). */
export interface PolicyPreview {
  scope: ApprovalScope;
  scopeLabel: string;
  amount: string;
  currency: string;
  /** Policy the engine would choose (`null` = the defaults of the config). */
  policyId: string | null;
  fromDefaults: boolean;
  requiredApprovals: number;
  approvers: Array<{ id: string; name: string }>;
  /** Spanish explanation of what would happen. */
  summary: string;
  warning: string | null;
}

export const PREVIEW_MAX_APPROVERS = 25;

/** Spanish summary of a preview; pure so the test can pin the wording. */
export function describePolicyPreview(input: {
  requiredApprovals: number;
  approvers: number;
  fromDefaults: boolean;
}): { summary: string; warning: string | null } {
  const source = input.fromDefaults
    ? 'con los valores por omisión de la configuración (este alcance no tiene políticas activas)'
    : 'con la política que aplica';
  if (input.requiredApprovals === 0) {
    return { summary: `Se aprobaría solo, sin pedir firma, ${source}.`, warning: null };
  }
  const signatures = describeRequiredSignatures(input.requiredApprovals).toLowerCase();
  const summary = `Pediría ${signatures} ${source}; hay ${input.approvers} ${
    input.approvers === 1 ? 'persona elegible' : 'personas elegibles'
  }.`;
  if (input.approvers < input.requiredApprovals) {
    return {
      summary,
      warning:
        'No hay suficientes personas elegibles: el comando sería rechazado con «no_approvers». Da el permiso del alcance o agrega roles aprobadores a la política.',
    };
  }
  return { summary, warning: null };
}
