import { Prisma, type CashAccount, type CostCenter, type FinanceCategory } from '@prisma/client';
import { z } from 'zod';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { AREA_KEYS, AREA_LABELS, type AreaKey } from '@/modules/operations/types';
import { financeError } from './finance-errors';
import { financeEventOptions, publishBoard } from './finance-helpers';
import { localDateKey, periodKeySchema } from './finance-dates';
import { D, currencySchema, nonNegativeMoneySchema, roundMoney } from './money';
import {
  CASH_ACCOUNT_KINDS,
  CASH_ACCOUNT_STATUSES,
  CATALOG_STATUSES,
  CATEGORY_KINDS,
  FINANCE_EVENTS,
  FINANCE_OBJECT_TYPES,
  LEDGER_SOURCE_TYPES,
  OPENING_BALANCE_EQUITY_ID,
  type CashAccountKind,
  type CategoryKind,
} from './types';

/**
 * Catalog of the internal accounting: cash accounts, categories (tree),
 * cost centers (tree, one per area) and budgets.
 *
 * `ensureFinanceSeed(db)` is idempotent (INSERT … ON CONFLICT DO NOTHING by
 * key) and runs lazily wherever a seeded key is needed, so a fresh
 * installation works without a manual step: "Caja general", "Banco (Zoho)",
 * base income / expense / payroll / tax categories and one cost center per
 * area. Editing is `finance.manage_catalog`.
 */

type Db = Prisma.TransactionClient;

export const FINANCE_CATEGORY_KEYS = {
  sales: 'ventas',
  otherIncome: 'otros_ingresos',
  supplierPurchases: 'compras_mercancia',
  general: 'gastos_generales',
  badDebt: 'cuentas_incobrables',
  payroll: 'nomina_sueldos',
  advances: 'nomina_anticipos',
  taxes: 'impuestos',
  loans: 'prestamos',
  transfers: 'traspasos',
} as const;

export const FINANCE_CASH_ACCOUNT_KEYS = {
  general: 'caja_general',
  zohoBank: 'banco_zoho',
} as const;

export const costCenterKeyForArea = (areaKey: AreaKey) => `cc_${areaKey}`;

interface SeedCategory {
  key: string;
  name: string;
  kind: CategoryKind;
  isDirect?: boolean;
  defaultArea?: AreaKey;
}

export const FINANCE_SEED_CASH_ACCOUNTS: ReadonlyArray<{ key: string; name: string; kind: CashAccountKind }> = [
  { key: FINANCE_CASH_ACCOUNT_KEYS.general, name: 'Caja general', kind: 'cash' },
  { key: FINANCE_CASH_ACCOUNT_KEYS.zohoBank, name: 'Banco (Zoho)', kind: 'bank' },
];

export const FINANCE_SEED_CATEGORIES: readonly SeedCategory[] = [
  { key: 'ventas', name: 'Ventas', kind: 'income', defaultArea: 'ventas' },
  { key: 'otros_ingresos', name: 'Otros ingresos', kind: 'income', defaultArea: 'contabilidad' },
  { key: 'compras_mercancia', name: 'Compras de mercancía', kind: 'expense', isDirect: true, defaultArea: 'compras' },
  { key: 'fletes', name: 'Fletes y envíos', kind: 'expense', isDirect: true, defaultArea: 'logistica' },
  { key: 'combustible', name: 'Combustible', kind: 'expense', defaultArea: 'logistica' },
  { key: 'mantenimiento', name: 'Mantenimiento y reparaciones', kind: 'expense', defaultArea: 'administracion' },
  { key: 'papeleria', name: 'Papelería y oficina', kind: 'expense', defaultArea: 'administracion' },
  { key: 'servicios', name: 'Servicios (luz, agua, internet, teléfono)', kind: 'expense', defaultArea: 'administracion' },
  { key: 'renta', name: 'Renta', kind: 'expense', defaultArea: 'administracion' },
  { key: 'viaticos', name: 'Viáticos', kind: 'expense', defaultArea: 'administracion' },
  { key: 'honorarios', name: 'Honorarios', kind: 'expense', defaultArea: 'administracion' },
  { key: 'comisiones_bancarias', name: 'Comisiones bancarias', kind: 'expense', defaultArea: 'contabilidad' },
  { key: 'publicidad', name: 'Publicidad', kind: 'expense', defaultArea: 'ventas' },
  { key: 'gastos_generales', name: 'Gastos generales', kind: 'expense', defaultArea: 'administracion' },
  { key: 'cuentas_incobrables', name: 'Cuentas incobrables', kind: 'expense', defaultArea: 'contabilidad' },
  { key: 'nomina_sueldos', name: 'Sueldos y salarios', kind: 'payroll', defaultArea: 'administracion' },
  { key: 'nomina_anticipos', name: 'Anticipos a empleados', kind: 'payroll', defaultArea: 'administracion' },
  { key: 'impuestos', name: 'Impuestos y derechos', kind: 'tax', defaultArea: 'contabilidad' },
  { key: 'prestamos', name: 'Préstamos y créditos', kind: 'debt', defaultArea: 'contabilidad' },
  { key: 'traspasos', name: 'Traspasos entre cuentas', kind: 'transfer' },
];

/** Idempotent seed of the base catalog. Returns how many rows it created. */
export async function ensureFinanceSeed(db: Db): Promise<{ created: number }> {
  let created = 0;
  const centers = await db.costCenter.createManyAndReturn({
    data: AREA_KEYS.map((areaKey) => ({
      key: costCenterKeyForArea(areaKey),
      name: AREA_LABELS[areaKey],
      areaKey,
    })),
    skipDuplicates: true,
    select: { id: true },
  });
  created += centers.length;
  const centerRows = await db.costCenter.findMany({
    where: { key: { in: AREA_KEYS.map(costCenterKeyForArea) } },
    select: { id: true, key: true },
  });
  const centerByKey = new Map(centerRows.map((row) => [row.key, row.id]));
  const categories = await db.financeCategory.createManyAndReturn({
    data: FINANCE_SEED_CATEGORIES.map((category) => ({
      key: category.key,
      name: category.name,
      kind: category.kind,
      isDirect: category.isDirect ?? false,
      defaultCostCenterId: category.defaultArea
        ? (centerByKey.get(costCenterKeyForArea(category.defaultArea)) ?? null)
        : null,
    })),
    skipDuplicates: true,
    select: { id: true },
  });
  created += categories.length;
  const accounts = await db.cashAccount.createManyAndReturn({
    data: FINANCE_SEED_CASH_ACCOUNTS.map((account) => ({ ...account, currency: 'MXN' })),
    skipDuplicates: true,
    select: { id: true },
  });
  created += accounts.length;
  return { created };
}

/** Id of a category by key (seeding the base catalog when it is missing). */
export async function categoryIdByKey(db: Db, key: string): Promise<string> {
  let row = await db.financeCategory.findUnique({ where: { key }, select: { id: true, status: true } });
  if (!row) {
    await ensureFinanceSeed(db);
    row = await db.financeCategory.findUnique({ where: { key }, select: { id: true, status: true } });
  }
  if (!row) throw new OperationsError('invalid_config', `No existe la categoría contable «${key}»`);
  return row.id;
}

export async function cashAccountByKey(db: Db, key: string): Promise<CashAccount> {
  let row = await db.cashAccount.findUnique({ where: { key } });
  if (!row) {
    await ensureFinanceSeed(db);
    row = await db.cashAccount.findUnique({ where: { key } });
  }
  if (!row) throw new OperationsError('invalid_config', `No existe la cuenta de caja «${key}»`);
  return row;
}

export async function costCenterIdForArea(db: Db, areaKey: string | null | undefined): Promise<string | null> {
  if (!areaKey) return null;
  const row = await db.costCenter.findFirst({
    where: { areaKey, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const keySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,59}$/, 'Clave inválida (minúsculas, números y guion bajo)');
const nameSchema = z.string().trim().min(2).max(120);
const idSchema = z.string().trim().min(1).max(120);

export const cashAccountCreateSchema = z.object({
  key: keySchema,
  name: nameSchema,
  kind: z.enum(CASH_ACCOUNT_KINDS),
  currency: currencySchema.default('MXN'),
  openingBalance: nonNegativeMoneySchema.default('0'),
});

export const cashAccountUpdateSchema = z.object({
  cashAccountId: idSchema,
  name: nameSchema.optional(),
  kind: z.enum(CASH_ACCOUNT_KINDS).optional(),
  status: z.enum(CASH_ACCOUNT_STATUSES).optional(),
});

export const categoryCreateSchema = z.object({
  key: keySchema,
  name: nameSchema,
  kind: z.enum(CATEGORY_KINDS),
  isDirect: z.boolean().default(false),
  parentId: idSchema.nullish(),
  defaultCostCenterId: idSchema.nullish(),
});

export const categoryUpdateSchema = z.object({
  categoryId: idSchema,
  name: nameSchema.optional(),
  isDirect: z.boolean().optional(),
  parentId: idSchema.nullish(),
  defaultCostCenterId: idSchema.nullish(),
  status: z.enum(CATALOG_STATUSES).optional(),
});

export const costCenterCreateSchema = z.object({
  key: keySchema,
  name: nameSchema,
  areaKey: z.enum(AREA_KEYS).nullish(),
  parentId: idSchema.nullish(),
});

export const costCenterUpdateSchema = z.object({
  costCenterId: idSchema,
  name: nameSchema.optional(),
  areaKey: z.enum(AREA_KEYS).nullish(),
  parentId: idSchema.nullish(),
  status: z.enum(CATALOG_STATUSES).optional(),
});

export const budgetSetSchema = z.object({
  periodKey: periodKeySchema,
  costCenterId: z.string().trim().max(120).default(''),
  categoryId: z.string().trim().max(120).default(''),
  amount: nonNegativeMoneySchema,
  currency: currencySchema.default('MXN'),
});

// ---------------------------------------------------------------------------
// Handlers (inside finance commands)
// ---------------------------------------------------------------------------

function emitCatalog(ctx: CommandContext, entity: string, id: string, action: string): void {
  ctx.emit(
    FINANCE_EVENTS.catalog.changed,
    { entity, id, action },
    financeEventOptions(FINANCE_OBJECT_TYPES.catalog, `${entity}:${id}`)
  );
  publishBoard(ctx, 'finance.catalog', { entity, id, action });
}

async function assertKeyFree(
  delegate: { findUnique(args: { where: { key: string }; select: { id: true } }): Promise<{ id: string } | null> },
  key: string,
  label: string
): Promise<void> {
  if (await delegate.findUnique({ where: { key }, select: { id: true } })) {
    throw new OperationsError('duplicate_code', `Ya existe ${label} con la clave «${key}»`);
  }
}

/** Walks the parents: a node never becomes its own ancestor. */
async function assertNoCycle(
  load: (id: string) => Promise<{ parentId: string | null } | null>,
  selfId: string | null,
  parentId: string | null | undefined,
  label: string
): Promise<void> {
  if (!parentId) return;
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current) {
    if (current === selfId || seen.has(current)) {
      throw new OperationsError('invalid_payload', `${label}: el padre elegido crearía un ciclo`);
    }
    seen.add(current);
    const row = await load(current);
    if (!row) throw new OperationsError('not_found', `${label}: el padre no existe`);
    current = row.parentId;
    if (seen.size > 50) break;
  }
}

export async function createCashAccountInTx(
  tx: Db,
  input: z.output<typeof cashAccountCreateSchema>,
  ctx: CommandContext
): Promise<CashAccount> {
  await assertKeyFree(tx.cashAccount, input.key, 'una cuenta');
  const opening = roundMoney(input.openingBalance);
  let row = await tx.cashAccount.create({
    data: {
      key: input.key,
      name: input.name,
      kind: input.kind,
      currency: input.currency,
      // Informative only: the balance comes from the opening entry below, like every other balance.
      openingBalance: opening,
      currentBalance: new Prisma.Decimal(0),
    },
  });
  if (opening.greaterThan(0)) {
    const { postLedgerEntry } = await import('./ledger-service');
    await postLedgerEntry(
      tx,
      {
        kind: 'adjustment',
        dateKey: localDateKey(ctx.now),
        description: `Saldo inicial de ${row.name}`,
        currency: row.currency,
        sourceType: LEDGER_SOURCE_TYPES.manual,
        sourceId: null,
        meta: { action: 'opening_balance', cashAccountId: row.id },
        lines: [
          { accountType: 'cash', accountId: row.id, debit: opening, memo: 'Saldo inicial' },
          { accountType: 'equity', accountId: OPENING_BALANCE_EQUITY_ID, credit: opening, memo: `Saldo inicial de ${row.name}` },
        ],
      },
      ctx
    );
    row = await tx.cashAccount.findUniqueOrThrow({ where: { id: row.id } });
  }
  emitCatalog(ctx, 'cash_account', row.id, 'created');
  return row;
}

/** Name / kind / status. Closing needs a zero balance. The command aggregate is the account. */
export async function updateCashAccountInTx(
  tx: Db,
  input: z.output<typeof cashAccountUpdateSchema>,
  ctx: CommandContext
): Promise<CashAccount> {
  const account = await tx.cashAccount.findUnique({ where: { id: input.cashAccountId } });
  if (!account) throw new OperationsError('not_found', 'No se encontró la cuenta');
  if (input.status === 'closed' && account.status !== 'closed' && !D(account.currentBalance).isZero()) {
    throw financeError('invalid_state', `La cuenta ${account.name} tiene saldo; traspásalo antes de cerrarla`);
  }
  const row = await tx.cashAccount.update({
    where: { id: account.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
  });
  emitCatalog(ctx, 'cash_account', row.id, 'updated');
  return row;
}

export async function createCategoryInTx(
  tx: Db,
  input: z.output<typeof categoryCreateSchema>,
  ctx: CommandContext
): Promise<FinanceCategory> {
  await assertKeyFree(tx.financeCategory, input.key, 'una categoría');
  await assertNoCycle((id) => tx.financeCategory.findUnique({ where: { id }, select: { parentId: true } }), null, input.parentId, 'Categoría');
  if (input.defaultCostCenterId) {
    const center = await tx.costCenter.findUnique({ where: { id: input.defaultCostCenterId }, select: { id: true } });
    if (!center) throw new OperationsError('not_found', 'El centro de costo por omisión no existe');
  }
  const row = await tx.financeCategory.create({
    data: {
      key: input.key,
      name: input.name,
      kind: input.kind,
      isDirect: input.isDirect,
      parentId: input.parentId ?? null,
      defaultCostCenterId: input.defaultCostCenterId ?? null,
    },
  });
  emitCatalog(ctx, 'category', row.id, 'created');
  return row;
}

export async function updateCategoryInTx(
  tx: Db,
  input: z.output<typeof categoryUpdateSchema>,
  ctx: CommandContext
): Promise<FinanceCategory> {
  const category = await tx.financeCategory.findUnique({ where: { id: input.categoryId } });
  if (!category) throw new OperationsError('not_found', 'No se encontró la categoría');
  if (input.parentId !== undefined) {
    await assertNoCycle((id) => tx.financeCategory.findUnique({ where: { id }, select: { parentId: true } }), category.id, input.parentId, 'Categoría');
  }
  if (input.defaultCostCenterId) {
    const center = await tx.costCenter.findUnique({ where: { id: input.defaultCostCenterId }, select: { id: true } });
    if (!center) throw new OperationsError('not_found', 'El centro de costo por omisión no existe');
  }
  const row = await tx.financeCategory.update({
    where: { id: category.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.isDirect !== undefined ? { isDirect: input.isDirect } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId ?? null } : {}),
      ...(input.defaultCostCenterId !== undefined ? { defaultCostCenterId: input.defaultCostCenterId ?? null } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
  });
  emitCatalog(ctx, 'category', row.id, 'updated');
  return row;
}

export async function createCostCenterInTx(
  tx: Db,
  input: z.output<typeof costCenterCreateSchema>,
  ctx: CommandContext
): Promise<CostCenter> {
  await assertKeyFree(tx.costCenter, input.key, 'un centro de costo');
  await assertNoCycle((id) => tx.costCenter.findUnique({ where: { id }, select: { parentId: true } }), null, input.parentId, 'Centro de costo');
  const row = await tx.costCenter.create({
    data: { key: input.key, name: input.name, areaKey: input.areaKey ?? null, parentId: input.parentId ?? null },
  });
  emitCatalog(ctx, 'cost_center', row.id, 'created');
  return row;
}

export async function updateCostCenterInTx(
  tx: Db,
  input: z.output<typeof costCenterUpdateSchema>,
  ctx: CommandContext
): Promise<CostCenter> {
  const center = await tx.costCenter.findUnique({ where: { id: input.costCenterId } });
  if (!center) throw new OperationsError('not_found', 'No se encontró el centro de costo');
  if (input.parentId !== undefined) {
    await assertNoCycle((id) => tx.costCenter.findUnique({ where: { id }, select: { parentId: true } }), center.id, input.parentId, 'Centro de costo');
  }
  const row = await tx.costCenter.update({
    where: { id: center.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.areaKey !== undefined ? { areaKey: input.areaKey ?? null } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId ?? null } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
  });
  emitCatalog(ctx, 'cost_center', row.id, 'updated');
  return row;
}

/** Upsert of the budget of a period + center + category (`''` = all). */
export async function setBudgetInTx(
  tx: Db,
  input: z.output<typeof budgetSetSchema>,
  ctx: CommandContext
): Promise<{ id: string; amount: string }> {
  if (input.costCenterId) {
    const center = await tx.costCenter.findUnique({ where: { id: input.costCenterId }, select: { id: true } });
    if (!center) throw new OperationsError('not_found', 'El centro de costo no existe');
  }
  if (input.categoryId) {
    const category = await tx.financeCategory.findUnique({ where: { id: input.categoryId }, select: { id: true } });
    if (!category) throw new OperationsError('not_found', 'La categoría no existe');
  }
  const amount = roundMoney(input.amount);
  const existing = await tx.budget.findFirst({
    where: { periodKey: input.periodKey, costCenterId: input.costCenterId, categoryId: input.categoryId },
    select: { id: true },
  });
  const row = existing
    ? await tx.budget.update({ where: { id: existing.id }, data: { amount, currency: input.currency } })
    : await tx.budget.create({
        data: {
          periodKey: input.periodKey,
          costCenterId: input.costCenterId,
          categoryId: input.categoryId,
          amount,
          currency: input.currency,
        },
      });
  emitCatalog(ctx, 'budget', row.id, existing ? 'updated' : 'created');
  return { id: row.id, amount: amount.toFixed(2) };
}
