import type {
  ApprovalRequest,
  Bom,
  BomLine,
  BomOperation,
  MaterialConsumption,
  ProductionOperation,
  ProductionOrder,
  ProductionOutput,
  QualityCheck,
} from '@prisma/client';
import { OperationsError } from '@/modules/operations/errors';
import {
  convertToBase,
  num,
  sameMeasure,
  unitFactor,
  type Db,
  type ItemUnits,
  type UnitsResolver,
} from './manufacturing-helpers';
import {
  DEFAULT_SCRAP_ALLOWANCE_PCT,
  MANUFACTURING_OBJECT_TYPES,
  type QualityResult,
} from './manufacturing-types';
import {
  grossRequiredInputQty,
  parseTransformationInputs,
  sortOperations,
  transformationRecipe,
  type OperationFacts,
  type RecipeLine,
  type ReleaseFacts,
} from './production-state';
import {
  computeMaterialBalance,
  evaluateScrap,
  scrapApprovalState,
  type MaterialBalance,
  type ScrapApprovalState,
  type ScrapEvaluation,
} from './scrap-rules';

/**
 * Facts of a production order read in one place (services and queries): the
 * recipe (explicit BOM or the implicit transformation BOM), material
 * requirements in base units, operations with their quality gates, posted
 * consumptions, outputs, scrap evaluation, material balance and the approvals
 * that gate the release.
 *
 * `MaterialConsumption` rows:
 * - `planned`: material assigned to the order on a stock row (`qtyPlanned`,
 *   counted in `StockItem.assignedToProduction`); `qtyActual` is what was drawn
 *   from that assignment.
 * - `actual`: a posted `consume` movement (`qtyPlanned` = the part covered by an
 *   assignment).
 * - `substitution`: a substitute consumed; posted when it has a movement,
 *   pending while its approval (outside the BOM) is undecided.
 */

const EPS = 1e-6;

export type BomWithRouting = Bom & { lines: BomLine[]; operations: BomOperation[] };

export interface ProductionRecipe {
  kind: 'transformation' | 'bom';
  lines: RecipeLine[];
  allowancePct: number;
  /** Planned output in the unit the recipe lines are expressed per (BOM output unit or planned unit). */
  plannedQtyForRecipe: number;
  /** Unit of `plannedQtyForRecipe`. */
  recipeOutputUnit: string;
  /** Routing operations that require a quality check (by name). */
  qcRequiredByName: Map<string, boolean>;
  bom: BomWithRouting | null;
  /** Expected yield of the BOM (fraction); null for transformations. */
  expectedYield: number | null;
}

export async function loadRecipe(
  db: Db,
  order: ProductionOrder,
  units: UnitsResolver
): Promise<ProductionRecipe> {
  if (order.kind === 'bom') {
    if (!order.bomId) throw new OperationsError('invalid_state', 'La orden no tiene lista de materiales');
    const bom = (await db.bom.findUnique({
      where: { id: order.bomId },
      include: { lines: true, operations: true },
    })) as BomWithRouting | null;
    if (!bom) throw new OperationsError('not_found', 'No se encontró la lista de materiales de la orden');
    const output = await units(order.outputZohoItemId);
    const plannedBase = convertToBase(order.plannedQty, order.plannedUnit, output);
    const factor = unitFactor(bom.outputUnit, output);
    const lines = [...bom.lines]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((line) => ({
        inputZohoItemId: line.inputZohoItemId,
        qtyPerOutput: num(line.qtyPerOutput),
        unit: line.unit,
        substitutes: [...line.substituteZohoItemIds],
        scrapPct: line.scrapPct === null ? null : num(line.scrapPct),
        variantKey: null,
      }));
    return {
      kind: 'bom',
      lines,
      allowancePct: bom.scrapAllowancePct === null ? DEFAULT_SCRAP_ALLOWANCE_PCT : num(bom.scrapAllowancePct),
      plannedQtyForRecipe: num(plannedBase.dividedBy(factor)),
      recipeOutputUnit: bom.outputUnit,
      qcRequiredByName: new Map(bom.operations.map((op) => [op.name, op.qcRequired])),
      bom,
      expectedYield: bom.expectedYield === null ? null : num(bom.expectedYield),
    };
  }
  const inputs = parseTransformationInputs(order.inputs);
  const recipe = transformationRecipe(inputs, num(order.plannedQty), DEFAULT_SCRAP_ALLOWANCE_PCT);
  return {
    kind: 'transformation',
    lines: recipe.lines,
    allowancePct: recipe.allowancePct,
    plannedQtyForRecipe: num(order.plannedQty),
    recipeOutputUnit: order.plannedUnit,
    qcRequiredByName: new Map(),
    bom: null,
    expectedYield: null,
  };
}

export interface MaterialRequirement {
  zohoItemId: string;
  /** Material to commit: net use grossed up by the line scrap and the BOM yield. */
  requiredBase: number;
  baseUnit: string;
  variantKey: string | null;
  substitutes: string[];
  item: ItemUnits;
  line: RecipeLine;
}

export async function computeRequirements(
  recipe: ProductionRecipe,
  units: UnitsResolver
): Promise<MaterialRequirement[]> {
  const out: MaterialRequirement[] = [];
  for (const line of recipe.lines) {
    const item = await units(line.inputZohoItemId);
    // BOM lines carry their expected scrap and the BOM its yield; a transformation states the input quantity itself
    // (its per-input percentage is the scrap allowance, not an expected scrap).
    const required =
      recipe.kind === 'bom'
        ? grossRequiredInputQty(line, recipe.plannedQtyForRecipe, recipe.expectedYield)
        : grossRequiredInputQty({ qtyPerOutput: line.qtyPerOutput, scrapPct: null }, recipe.plannedQtyForRecipe, null);
    out.push({
      zohoItemId: line.inputZohoItemId,
      requiredBase: num(convertToBase(required, line.unit, item)),
      baseUnit: item.baseUnit,
      variantKey: line.variantKey,
      substitutes: line.substitutes,
      item,
      line,
    });
  }
  return out;
}

export interface ProductionFacts {
  order: ProductionOrder;
  recipe: ProductionRecipe;
  requirements: MaterialRequirement[];
  outputUnits: ItemUnits;
  operations: ProductionOperation[];
  operationFacts: OperationFacts[];
  consumptions: MaterialConsumption[];
  outputs: ProductionOutput[];
  checks: QualityCheck[];
  producedBase: number;
  consumedByItem: Record<string, number>;
  scrapByItem: Record<string, number>;
  leftoverByItem: Record<string, number>;
  /** Σ qtyPlanned of the assignment rows per input. */
  assignedByItem: Record<string, number>;
  /** Assignment still held per input (qtyPlanned − qtyActual). */
  heldByItem: Record<string, number>;
  pendingSubstitutionIds: string[];
  scrap: ScrapEvaluation;
  scrapApprovals: ApprovalRequest[];
  scrapApproval: ScrapApprovalState;
  balance: MaterialBalance;
  lastOrderCheck: QualityCheck | null;
  /** Quantity (output base unit) the linked allocation needs; null without allocation. */
  requiredBase: number | null;
  /** Planned output in the output base unit (null when the planned unit cannot be converted). */
  plannedOutputBase: number | null;
}

function add(map: Record<string, number>, key: string, value: number): void {
  map[key] = Math.round(((map[key] ?? 0) + value) * 10_000) / 10_000;
}

export function operationFactsOf(
  operations: readonly ProductionOperation[],
  checks: readonly QualityCheck[],
  recipe: Pick<ProductionRecipe, 'qcRequiredByName'>
): OperationFacts[] {
  return sortOperations(operations).map((op) => ({
    id: op.id,
    seq: op.seq,
    name: op.name,
    status: op.status,
    qcRequired: recipe.qcRequiredByName.get(op.name) === true,
    passedCheck: checks.some(
      (check) => check.operationId === op.id && (check.result === 'pass' || check.result === 'conditional')
    ),
  }));
}

export async function loadProductionFacts(
  db: Db,
  order: ProductionOrder,
  units: UnitsResolver
): Promise<ProductionFacts> {
  const recipe = await loadRecipe(db, order, units);
  const [requirements, outputUnits, operations, consumptions, outputs, checks, scrapApprovals] =
    await Promise.all([
      computeRequirements(recipe, units),
      units(order.outputZohoItemId),
      db.productionOperation.findMany({
        where: { productionOrderId: order.id },
        orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      }),
      db.materialConsumption.findMany({
        where: { productionOrderId: order.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.productionOutput.findMany({
        where: { productionOrderId: order.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.qualityCheck.findMany({
        where: { productionOrderId: order.id },
        orderBy: [{ inspectedAt: 'asc' }, { id: 'asc' }],
      }),
      db.approvalRequest.findMany({
        where: { targetType: MANUFACTURING_OBJECT_TYPES.scrapReview, targetId: order.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

  const consumedByItem: Record<string, number> = {};
  const assignedByItem: Record<string, number> = {};
  const heldByItem: Record<string, number> = {};
  for (const requirement of requirements) {
    consumedByItem[requirement.zohoItemId] = 0;
    assignedByItem[requirement.zohoItemId] = 0;
    heldByItem[requirement.zohoItemId] = 0;
  }
  const substitutionApprovalIds = new Set<string>();
  for (const row of consumptions) {
    if (row.kind === 'planned') {
      add(assignedByItem, row.inputZohoItemId, num(row.qtyPlanned));
      add(heldByItem, row.inputZohoItemId, Math.max(0, num(row.qtyPlanned) - num(row.qtyActual)));
    } else if (row.stockMovementId) {
      add(consumedByItem, row.inputZohoItemId, num(row.qtyActual));
    } else if (row.kind === 'substitution' && row.approvalRequestId) {
      substitutionApprovalIds.add(row.approvalRequestId);
    }
  }
  const pendingApprovals =
    substitutionApprovalIds.size > 0
      ? await db.approvalRequest.findMany({
          where: { id: { in: [...substitutionApprovalIds] }, status: 'pending' },
          select: { id: true },
        })
      : [];
  const pendingIds = new Set(pendingApprovals.map((row) => row.id));
  const pendingSubstitutionIds = consumptions
    .filter(
      (row) =>
        row.kind === 'substitution' &&
        !row.stockMovementId &&
        row.approvalRequestId !== null &&
        pendingIds.has(row.approvalRequestId)
    )
    .map((row) => row.id);

  const scrapByItem: Record<string, number> = {};
  const leftoverByItem: Record<string, number> = {};
  let producedBase = 0;
  let lastScrapAt: Date | null = null;
  for (const output of outputs) {
    const quantity = num(output.qty);
    if (output.kind === 'finished') producedBase += quantity;
    else if (output.kind === 'scrap') {
      add(scrapByItem, output.zohoItemId, quantity);
      if (!lastScrapAt || output.createdAt > lastScrapAt) lastScrapAt = output.createdAt;
    } else if (output.kind === 'leftover') add(leftoverByItem, output.zohoItemId, quantity);
  }
  producedBase = Math.round(producedBase * 10_000) / 10_000;

  const scrap = evaluateScrap({
    allowancePct: recipe.allowancePct,
    outputZohoItemId: order.outputZohoItemId,
    produced: producedBase,
    consumedByItem,
    scrapByItem,
  });

  const balanceLines = [];
  for (const requirement of requirements) {
    const substituteItems = requirement.substitutes.filter((id) => consumedByItem[id] !== undefined);
    let consumed = consumedByItem[requirement.zohoItemId] ?? 0;
    let leftover = leftoverByItem[requirement.zohoItemId] ?? 0;
    let scrapQty = scrapByItem[requirement.zohoItemId] ?? 0;
    // Each substitute item counts once: its totals already add every consumption row of it.
    const substitutes = new Set([
      ...substituteItems,
      ...consumptions
        .filter(
          (row) =>
            row.kind === 'substitution' &&
            row.stockMovementId &&
            row.substitutedForZohoItemId === requirement.zohoItemId &&
            row.inputZohoItemId !== requirement.zohoItemId
        )
        .map((row) => row.inputZohoItemId),
    ]);
    for (const substitute of substitutes) {
      const substituteUnits = await units(substitute);
      if (!sameMeasure(substituteUnits.baseUnit, requirement.baseUnit)) continue;
      consumed += consumedByItem[substitute] ?? 0;
      leftover += leftoverByItem[substitute] ?? 0;
      scrapQty += scrapByItem[substitute] ?? 0;
    }
    let qtyPerOutput: number | null = null;
    if (recipe.kind === 'bom') {
      const lineFactor = num(unitFactor(requirement.line.unit, requirement.item));
      const outputFactor = num(unitFactor(recipe.recipeOutputUnit, outputUnits));
      qtyPerOutput = outputFactor > EPS ? (requirement.line.qtyPerOutput * lineFactor) / outputFactor : null;
    } else if (sameMeasure(outputUnits.baseUnit, requirement.baseUnit)) {
      qtyPerOutput = 1;
    }
    balanceLines.push({
      zohoItemId: requirement.zohoItemId,
      consumed,
      leftover,
      scrap: scrapQty,
      qtyPerOutput,
      tolerancePct: requirement.item.tolerancePct,
    });
  }
  // Defective output pieces (scrap of the output item, when it is not itself an input) used material too.
  const outputIsInput = requirements.some((requirement) => requirement.zohoItemId === order.outputZohoItemId);
  const outputScrap = outputIsInput ? 0 : (scrapByItem[order.outputZohoItemId] ?? 0);
  const balance = computeMaterialBalance({ produced: producedBase, outputScrap, lines: balanceLines });
  let plannedOutputBase: number | null = null;
  try {
    plannedOutputBase = num(convertToBase(order.plannedQty, order.plannedUnit, outputUnits));
  } catch {
    plannedOutputBase = null;
  }

  const orderChecks = checks.filter((check) => check.operationId === null);
  const lastOrderCheck = orderChecks.length > 0 ? orderChecks[orderChecks.length - 1] : null;

  let requiredBase: number | null = null;
  if (order.demandAllocationId) {
    const allocation = await db.demandAllocation.findUnique({
      where: { id: order.demandAllocationId },
      select: { quantity: true, demandId: true },
    });
    if (allocation) {
      const demand = await db.caseDemand.findUnique({
        where: { id: allocation.demandId },
        select: { baseUnit: true },
      });
      try {
        requiredBase = num(convertToBase(allocation.quantity, demand?.baseUnit || outputUnits.baseUnit, outputUnits));
      } catch {
        requiredBase = num(allocation.quantity);
      }
    }
  }

  return {
    order,
    recipe,
    requirements,
    outputUnits,
    operations,
    operationFacts: operationFactsOf(operations, checks, recipe),
    consumptions,
    outputs,
    checks,
    producedBase,
    consumedByItem,
    scrapByItem,
    leftoverByItem,
    assignedByItem,
    heldByItem,
    pendingSubstitutionIds,
    scrap,
    scrapApprovals,
    scrapApproval: scrapApprovalState(scrapApprovals, lastScrapAt),
    balance,
    lastOrderCheck,
    requiredBase,
    plannedOutputBase,
  };
}

export function releaseFactsOf(
  facts: ProductionFacts,
  options: { acceptBalanceDifference?: boolean; scrapApproval?: ScrapApprovalState } = {}
): ReleaseFacts {
  return {
    status: facts.order.status,
    operations: facts.operations,
    producedBase: facts.producedBase,
    requiredBase: facts.requiredBase,
    baseUnit: facts.outputUnits.baseUnit,
    lastOrderCheck: (facts.lastOrderCheck?.result as QualityResult | undefined) ?? null,
    pendingSubstitutions: facts.pendingSubstitutionIds.length,
    scrapExceeded: facts.scrap.exceeded,
    scrapApproval: options.scrapApproval ?? facts.scrapApproval,
    balanceComparable: facts.balance.comparable,
    balanceBalanced: facts.balance.balanced,
    acceptBalanceDifference: options.acceptBalanceDifference === true,
    scrapPending: facts.scrap.pending,
    materials: facts.requirements.map((requirement) => {
      const line = facts.balance.lines.find((row) => row.zohoItemId === requirement.zohoItemId);
      // What the actual output needs (net use of the recipe, scaled to what was produced).
      const producedShare =
        facts.plannedOutputBase !== null && facts.plannedOutputBase > EPS
          ? Math.min(1, facts.producedBase / facts.plannedOutputBase)
          : 1;
      const netPlanned =
        facts.recipe.kind === 'bom' ? requirement.requiredBase / grossFactorOf(requirement, facts.recipe.expectedYield) : requirement.requiredBase;
      return {
        zohoItemId: requirement.zohoItemId,
        assigned: facts.assignedByItem[requirement.zohoItemId] ?? 0,
        consumed: line?.consumed ?? facts.consumedByItem[requirement.zohoItemId] ?? 0,
        expected: Math.round(netPlanned * producedShare * 10_000) / 10_000,
        tolerancePct: Math.max(requirement.item.tolerancePct, facts.recipe.allowancePct),
        comparable: line?.comparable ?? false,
      };
    }),
  };
}

function grossFactorOf(requirement: MaterialRequirement, expectedYield: number | null): number {
  const scrapFactor = 1 + Math.max(0, requirement.line.scrapPct ?? 0) / 100;
  const yieldFactor = expectedYield !== null && expectedYield > EPS && expectedYield <= 1 ? expectedYield : 1;
  return scrapFactor / yieldFactor;
}
