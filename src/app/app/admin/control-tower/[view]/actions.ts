'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  CT_EXCEPTIONS_BASE_PATH,
  CT_EXCEPTION_EXPORT_COLUMNS,
  CT_EXCEPTIONS_TABLE_KEY,
  exceptionExportValue,
} from '@/components/control-tower/exceptions-columns';
import {
  CtExceptionQueryError,
  ctExceptionQueryStateSchema,
  parseCtExceptionQuery,
  toExceptionServiceQuery,
} from '@/components/control-tower/exceptions-model';
import {
  approvalPolicyFormSchema,
  describePolicyPreview,
  type ApprovalPolicyFormInput,
  type ApprovalPolicyRow,
  type PolicyPreview,
} from '@/components/control-tower/policy-model';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import {
  AuthorizationError,
  getCurrentSession,
  hasPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { CONTROL_TOWER_PERMISSION } from '@/modules/control-tower/control-tower-service';
import { listControlTowerExceptions } from '@/modules/control-tower/exceptions-service';
import { isOperationsError } from '@/modules/operations/errors';
import {
  findEligibleApprovers,
  resolveApprovalRequirement,
} from '@/modules/operations/approvals-service';
import {
  updateOperationsConfig,
  type OperationsConfig,
  type OperationsConfigPatch,
} from '@/modules/operations/operations-config';
import { enqueueRelationsRebuild } from '@/modules/operations/operations-jobs';
import {
  updateSourcingConfig,
  type SourcingConfig,
  type SourcingConfigPatch,
} from '@/modules/purchases/sourcing-config';
import { APPROVAL_SCOPES, APPROVAL_SCOPE_LABELS } from '@/modules/operations/types';
import {
  deleteUserTablePreference,
  upsertUserTablePreference,
} from '@/modules/sales/table-preferences-service';
import { createTableView } from '@/modules/sales/table-views-service';
import type { TablePreferenceConfig } from '@/modules/shared/entity-workspace-types';
import { listApprovalPolicies } from './_data';

/**
 * Server actions of the Control Tower (plan 7.7). Every one of them re-checks
 * `operations.admin`: the page gate is not a permission check for a POST.
 *
 * Nothing here decides business. The configuration is written by
 * `updateOperationsConfig` (which validates with Zod, merges deeply and guards
 * the row with its `updatedAt`), and the approval preview asks the very
 * functions the engine uses (`resolveApprovalRequirement`,
 * `findEligibleApprovers`) instead of re-implementing the rule.
 */

function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message;
  if (error instanceof CtExceptionQueryError) return error.message;
  if (isOperationsError(error)) return error.message;
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? `${issue.path.join('.') || 'dato'}: ${issue.message}` : 'Datos inválidos';
  }
  if (error instanceof Error) return error.message;
  return 'Ocurrió un error inesperado';
}

async function requireControlTowerActor(): Promise<CurrentUser> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!hasPermission(session.user, CONTROL_TOWER_PERMISSION)) {
    throw new AuthorizationError('Necesitas permiso de administrar operaciones');
  }
  return session.user;
}

// ---------------------------------------------------------------------------
// Configuración del núcleo
// ---------------------------------------------------------------------------

export async function saveOperationsConfigAction(
  patch: OperationsConfigPatch
): Promise<{ success: boolean; error: string | null; config: OperationsConfig | null }> {
  try {
    const user = await requireControlTowerActor();
    const config = await updateOperationsConfig(patch, { actorUserId: user.id });
    revalidatePath('/app/admin/control-tower/configuracion');
    return { success: true, error: null, config };
  } catch (error) {
    return { success: false, error: errorMessage(error), config: null };
  }
}

/**
 * Configuración del Laboratorio de Sourcing (plan 6.1). Vive aquí porque es la
 * misma superficie y la misma puerta que la configuración de operaciones:
 * `updateSourcingConfig` vuelve a exigir `operations.admin`, valida el parche
 * con su propio esquema y protege la fila con su `updatedAt`.
 */
export async function saveSourcingConfigAction(
  patch: SourcingConfigPatch
): Promise<{ success: boolean; error: string | null; config: SourcingConfig | null }> {
  try {
    const user = await requireControlTowerActor();
    const config = await updateSourcingConfig(user, patch);
    revalidatePath('/app/admin/control-tower/configuracion');
    return { success: true, error: null, config };
  } catch (error) {
    return { success: false, error: errorMessage(error), config: null };
  }
}

// ---------------------------------------------------------------------------
// Políticas de aprobación
// ---------------------------------------------------------------------------

const policyIdSchema = z.string().trim().min(1).max(120);

function decimalOrNull(value: string): Prisma.Decimal | null {
  return value === '' ? null : new Prisma.Decimal(value);
}

export async function savePolicyAction(input: {
  id: string | null;
  form: ApprovalPolicyFormInput;
}): Promise<{ success: boolean; error: string | null; policies: ApprovalPolicyRow[] | null }> {
  try {
    const user = await requireControlTowerActor();
    const form = approvalPolicyFormSchema.parse(input.form);
    const data = {
      scope: form.scope,
      categoryId: form.categoryId ? form.categoryId : null,
      minAmount: new Prisma.Decimal(form.minAmount === '' ? '0' : form.minAmount),
      maxAmount: decimalOrNull(form.maxAmount),
      currency: form.currency,
      requiredApprovals: form.requiredApprovals,
      approverRoleKeys: [...new Set(form.approverRoleKeys)],
      active: form.active,
    };

    let policyId: string;
    if (input.id) {
      const id = policyIdSchema.parse(input.id);
      const existing = await prisma.approvalPolicy.findUnique({ where: { id } });
      if (!existing) {
        return { success: false, error: 'La política ya no existe', policies: null };
      }
      await prisma.approvalPolicy.update({ where: { id }, data });
      policyId = id;
    } else {
      const created = await prisma.approvalPolicy.create({ data });
      policyId = created.id;
    }

    await recordAuditEvent({
      actorUserId: user.id,
      action: input.id
        ? 'operations.approval_policy.updated'
        : 'operations.approval_policy.created',
      targetType: 'approval_request',
      targetId: policyId,
      metadata: {
        scope: data.scope,
        currency: data.currency,
        minAmount: data.minAmount.toString(),
        maxAmount: data.maxAmount?.toString() ?? null,
        requiredApprovals: data.requiredApprovals,
        approverRoleKeys: data.approverRoleKeys,
        active: data.active,
      },
    });

    revalidatePath('/app/admin/control-tower/configuracion');
    return { success: true, error: null, policies: await listApprovalPolicies() };
  } catch (error) {
    return { success: false, error: errorMessage(error), policies: null };
  }
}

export async function deletePolicyAction(
  id: string
): Promise<{ success: boolean; error: string | null; policies: ApprovalPolicyRow[] | null }> {
  try {
    const user = await requireControlTowerActor();
    const policyId = policyIdSchema.parse(id);
    const existing = await prisma.approvalPolicy.findUnique({ where: { id: policyId } });
    if (!existing) {
      return { success: false, error: 'La política ya no existe', policies: null };
    }
    await prisma.approvalPolicy.delete({ where: { id: policyId } });
    await recordAuditEvent({
      actorUserId: user.id,
      action: 'operations.approval_policy.deleted',
      targetType: 'approval_request',
      targetId: policyId,
      metadata: { scope: existing.scope, currency: existing.currency },
    });
    revalidatePath('/app/admin/control-tower/configuracion');
    return { success: true, error: null, policies: await listApprovalPolicies() };
  } catch (error) {
    return { success: false, error: errorMessage(error), policies: null };
  }
}

const previewSchema = z.object({
  scope: z.enum(APPROVAL_SCOPES),
  amount: z
    .string()
    .trim()
    .max(24)
    .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0, {
      message: 'Escribe un importe válido',
    }),
  currency: z.string().trim().min(3).max(8),
  categoryId: z.string().trim().max(120).optional().default(''),
});

/**
 * "¿A quién le pediría firma esta política?" — resolved with the SAME functions
 * `requestApproval` uses, so the answer is not a guess. It creates nothing.
 */
export async function previewPolicyAction(input: {
  scope: string;
  amount: string;
  currency: string;
  categoryId: string;
}): Promise<{ success: boolean; error: string | null; preview: PolicyPreview | null }> {
  try {
    const user = await requireControlTowerActor();
    const parsed = previewSchema.parse(input);
    const requirement = await resolveApprovalRequirement(prisma, {
      scope: parsed.scope,
      amount: new Prisma.Decimal(parsed.amount === '' ? '0' : parsed.amount),
      currency: parsed.currency,
      categoryId: parsed.categoryId ? parsed.categoryId : null,
    });
    // The requester is excluded from their own approval; previewing as the
    // current user therefore shows the real pool for a request they would open.
    const approvers = await findEligibleApprovers(
      prisma,
      parsed.scope,
      requirement.policy.approverRoleKeys,
      user.id
    );
    const { summary, warning } = describePolicyPreview({
      requiredApprovals: requirement.requiredApprovals,
      approvers: approvers.length,
      fromDefaults: requirement.policy.id === null,
    });
    return {
      success: true,
      error: null,
      preview: {
        scope: parsed.scope,
        scopeLabel: APPROVAL_SCOPE_LABELS[parsed.scope],
        amount: parsed.amount,
        currency: parsed.currency,
        policyId: requirement.policy.id,
        fromDefaults: requirement.policy.id === null,
        requiredApprovals: requirement.requiredApprovals,
        approvers: approvers.map((row) => ({ id: row.id, name: row.name })),
        summary,
        warning,
      },
    };
  } catch (error) {
    return { success: false, error: errorMessage(error), preview: null };
  }
}

// ---------------------------------------------------------------------------
// Proyección del grafo (plan 2.1: `ObjectRelation` reconstruible)
// ---------------------------------------------------------------------------

/** Vacío = todas las fuentes. `enqueueRelationsRebuild` descarta las que no existan. */
const relationSourcesSchema = z.array(z.string().trim().min(1).max(60)).max(50);

/**
 * Encola la reconstrucción de `ObjectRelation` desde las tablas de origen. Es
 * el único camino para dispararla: sin esto la proyección sólo se escribe
 * durante cada comando y, si un `relate` falla, queda desfasada para siempre.
 *
 * No reconstruye aquí: `enqueueRelationsRebuild` deduplica por tipo, así que
 * dos administradores que lo pidan a la vez comparten el mismo trabajo.
 */
export async function rebuildRelationsAction(sources: string[] = []): Promise<{
  success: boolean;
  error: string | null;
  jobId: string | null;
  deduplicated: boolean;
}> {
  try {
    const user = await requireControlTowerActor();
    const requested = relationSourcesSchema.parse(sources);
    const job = await enqueueRelationsRebuild({
      requestedByUserId: user.id,
      ...(requested.length > 0 ? { sources: requested } : {}),
    });
    await recordAuditEvent({
      actorUserId: user.id,
      action: 'operations.relations.rebuild_requested',
      // `control_tower` es el tipo de la administración de la propia operación:
      // así el evento sí aparece en el filtro de la vista de auditoría.
      targetType: 'control_tower',
      targetId: job.id,
      metadata: {
        jobId: job.id,
        sources: requested.length > 0 ? requested : 'all',
        deduplicated: job.deduplicated,
      },
    });
    revalidatePath('/app/admin/control-tower/configuracion');
    return { success: true, error: null, jobId: job.id, deduplicated: job.deduplicated };
  } catch (error) {
    return { success: false, error: errorMessage(error), jobId: null, deduplicated: false };
  }
}

// ---------------------------------------------------------------------------
// Tabla de excepciones: preferencias, vistas y exportación
// ---------------------------------------------------------------------------

export async function saveExceptionsPreferenceAction(
  config: TablePreferenceConfig
): Promise<{ error: string | null; success: boolean }> {
  try {
    const user = await requireControlTowerActor();
    await upsertUserTablePreference(user.id, CT_EXCEPTIONS_TABLE_KEY, config);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

export async function resetExceptionsPreferenceAction(): Promise<{
  error: string | null;
  success: boolean;
}> {
  try {
    const user = await requireControlTowerActor();
    await deleteUserTablePreference(user.id, CT_EXCEPTIONS_TABLE_KEY);
    revalidatePath(CT_EXCEPTIONS_BASE_PATH);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const createViewSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(100),
  visibility: z.enum(['private', 'shared']).default('private'),
  config: z.string(),
  isDefault: z.boolean().default(false),
});

/** Config of a saved view: the same query state the table posts. */
const exceptionViewConfigSchema = z.object({
  query: ctExceptionQueryStateSchema,
  columnOrder: z.array(z.string().max(80)).max(60).optional(),
  columnVisibility: z.record(z.boolean()).optional(),
});

export async function createExceptionsViewAction(
  _prevState: { error: string | null; success: boolean; viewId: string | null },
  formData: FormData
): Promise<{ error: string | null; success: boolean; viewId: string | null }> {
  try {
    const user = await requireControlTowerActor();
    const parsed = createViewSchema.safeParse({
      name: formData.get('name'),
      visibility: formData.get('visibility') ?? 'private',
      config: formData.get('config'),
      isDefault: formData.get('isDefault') === 'true',
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Datos inválidos',
        success: false,
        viewId: null,
      };
    }
    let config: unknown;
    try {
      config = JSON.parse(parsed.data.config);
    } catch {
      return { error: 'Configuración inválida', success: false, viewId: null };
    }
    const view = await createTableView(user, {
      tableKey: CT_EXCEPTIONS_TABLE_KEY,
      name: parsed.data.name,
      visibility: parsed.data.visibility,
      config,
      isDefault: parsed.data.isDefault,
      configSchema: exceptionViewConfigSchema.passthrough(),
      sharePermission: CONTROL_TOWER_PERMISSION,
    });
    revalidatePath(CT_EXCEPTIONS_BASE_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

/**
 * Following an exception is NOT available: nothing produces change events for
 * these rows, so a star would promise a notification that never arrives. The
 * table hides the control (`canWatch={false}`) and these actions exist only
 * because the shared workspace requires them.
 */
const WATCH_UNAVAILABLE = 'El seguimiento no está disponible en las excepciones';

export async function watchExceptionAction(): Promise<{
  error: string | null;
  success: boolean;
  isWatched: boolean;
}> {
  return { error: WATCH_UNAVAILABLE, success: false, isWatched: false };
}

export async function bulkWatchExceptionsAction(): Promise<{
  error: string | null;
  success: boolean;
  isWatched: boolean;
}> {
  return { error: WATCH_UNAVAILABLE, success: false, isWatched: false };
}

const exportSchema = z.object({
  format: z.enum(['csv', 'xlsx']),
  scope: z.enum(['current_page', 'selected', 'filtered']),
  selectedIds: z.array(z.string().max(200)).max(500).optional(),
  query: z.string(),
});

type ExportState = {
  error: string | null;
  success: boolean;
  content: string | null;
  filename: string | null;
  format: string | null;
};

const EMPTY_EXPORT: ExportState = {
  error: null,
  success: false,
  content: null,
  filename: null,
  format: null,
};

/** Rows an export must contain, bounded so a click never scans the whole table. */
const EXPORT_MAX_ROWS = 2000;

export async function exportExceptionsAction(
  _prevState: ExportState,
  formData: FormData
): Promise<ExportState> {
  try {
    const user = await requireControlTowerActor();
    const parsed = exportSchema.safeParse({
      format: formData.get('format'),
      scope: formData.get('scope'),
      selectedIds: formData.getAll('selectedIds').map(String),
      query: formData.get('query'),
    });
    if (!parsed.success) return { ...EMPTY_EXPORT, error: 'Datos inválidos' };

    let rawQuery: unknown;
    try {
      rawQuery = JSON.parse(parsed.data.query);
    } catch {
      return { ...EMPTY_EXPORT, error: 'Consulta inválida' };
    }

    const state = parseCtExceptionQuery(rawQuery);
    const serviceQuery = toExceptionServiceQuery(state);
    const page = await listControlTowerExceptions(
      user,
      parsed.data.scope === 'current_page'
        ? serviceQuery
        : { ...serviceQuery, page: 1, page_size: 200 }
    );

    let rows = page.data;
    if (parsed.data.scope === 'selected') {
      const ids = new Set(parsed.data.selectedIds ?? []);
      rows = rows.filter((row) => ids.has(row.id));
    } else if (parsed.data.scope === 'filtered') {
      // Keep asking for pages until the cap; the service pages at 200.
      let current = page;
      while (
        rows.length < EXPORT_MAX_ROWS &&
        current.pagination.page < current.pagination.total_pages
      ) {
        current = await listControlTowerExceptions(user, {
          ...serviceQuery,
          page: current.pagination.page + 1,
          page_size: 200,
        });
        rows = [...rows, ...current.data];
      }
      rows = rows.slice(0, EXPORT_MAX_ROWS);
    }

    const columns = CT_EXCEPTION_EXPORT_COLUMNS;
    const timestamp = new Date().toISOString().split('T')[0];
    const base = `excepciones-${timestamp}`;

    await recordAuditEvent({
      actorUserId: user.id,
      action: 'control_tower.exceptions_exported',
      targetType: 'control_tower',
      targetId: 'excepciones',
      metadata: { format: parsed.data.format, rowCount: rows.length, scope: parsed.data.scope },
    });

    if (parsed.data.format === 'csv') {
      const header = columns.map((column) => `"${column.label.replace(/"/g, '""')}"`).join(',');
      const lines = rows.map((row) =>
        columns
          .map((column) => `"${exceptionExportValue(row, column.id).replace(/"/g, '""')}"`)
          .join(',')
      );
      const csv = [header, ...lines].join('\r\n');
      return {
        error: null,
        success: true,
        content: Buffer.from(`﻿${csv}`, 'utf-8').toString('base64'),
        filename: `${base}.csv`,
        format: 'csv',
      };
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Excepciones');
    sheet.columns = columns.map((column) => ({
      header: column.label,
      key: column.id,
      width: Math.min(Math.max(column.defaultWidth / 8, 12), 40),
    }));
    for (const row of rows) {
      sheet.addRow(
        Object.fromEntries(
          columns.map((column) => [column.id, exceptionExportValue(row, column.id)])
        )
      );
    }
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    return {
      error: null,
      success: true,
      content: Buffer.from(buffer).toString('base64'),
      filename: `${base}.xlsx`,
      format: 'xlsx',
    };
  } catch (error) {
    return { ...EMPTY_EXPORT, error: errorMessage(error) };
  }
}
