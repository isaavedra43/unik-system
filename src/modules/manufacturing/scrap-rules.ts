/**
 * Scrap tolerance and material balance of a production order (plan 6.2). Pure
 * module: quantities are numbers in the base unit of each item.
 *
 * Scrap: `scrap / input > scrapAllowancePct`. For an input material the basis is
 * what was consumed of it (planned, declared substitutes and approved
 * substitutions); for defective finished goods of the output item (when it is not
 * also an input) the basis is produced + scrap. Scrap recorded before any
 * consumption cannot be judged yet (`pending`).
 *
 * Balance: consumed = produced × qtyPerOutput + leftover + scrap, per input,
 * within the measurement tolerance of the item. `qtyPerOutput` is the NET input
 * per output unit (a BOM line), or 1 for a transformation whose output is
 * measured in the same unit as its input (m² in → m² out). Without a ratio the
 * line is reported but not comparable, so it never blocks a release.
 */

const EPS = 1e-6;

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Scrap
// ---------------------------------------------------------------------------

/** Percentage of scrap over its basis (null when there is no basis). */
export function scrapPct(scrap: number, basis: number): number | null {
  if (basis <= EPS) return scrap <= EPS ? 0 : null;
  return round((Math.max(0, scrap) / basis) * 100, 2);
}

export interface ScrapEvaluationInput {
  allowancePct: number;
  outputZohoItemId: string;
  produced: number;
  consumedByItem: Readonly<Record<string, number>>;
  scrapByItem: Readonly<Record<string, number>>;
}

export interface ScrapLineResult {
  zohoItemId: string;
  role: 'input' | 'output';
  basis: number;
  scrap: number;
  pct: number | null;
  exceeded: boolean;
  /** Scrap without a basis yet (nothing consumed): not judged. */
  pending: boolean;
}

export interface ScrapEvaluation {
  allowancePct: number;
  lines: ScrapLineResult[];
  exceeded: boolean;
  pending: boolean;
  maxPct: number | null;
  totalScrap: number;
}

export function evaluateScrap(input: ScrapEvaluationInput): ScrapEvaluation {
  const allowance = Math.max(0, input.allowancePct);
  const items = new Set<string>([
    ...Object.keys(input.consumedByItem),
    ...Object.entries(input.scrapByItem)
      .filter(([, value]) => value > EPS)
      .map(([key]) => key),
  ]);
  const lines: ScrapLineResult[] = [];
  for (const zohoItemId of [...items].sort()) {
    const consumed = Math.max(0, input.consumedByItem[zohoItemId] ?? 0);
    const scrap = Math.max(0, input.scrapByItem[zohoItemId] ?? 0);
    const isInput = Object.prototype.hasOwnProperty.call(input.consumedByItem, zohoItemId);
    const role: ScrapLineResult['role'] =
      !isInput && zohoItemId === input.outputZohoItemId ? 'output' : 'input';
    const basis = role === 'output' ? Math.max(0, input.produced) + scrap : consumed;
    const pct = scrapPct(scrap, basis);
    lines.push({
      zohoItemId,
      role,
      basis: round(basis),
      scrap: round(scrap),
      pct,
      exceeded: pct !== null && pct > allowance + EPS,
      pending: scrap > EPS && basis <= EPS,
    });
  }
  const pcts = lines.map((line) => line.pct).filter((pct): pct is number => pct !== null);
  return {
    allowancePct: allowance,
    lines,
    exceeded: lines.some((line) => line.exceeded),
    pending: lines.some((line) => line.pending),
    maxPct: pcts.length > 0 ? Math.max(...pcts) : null,
    totalScrap: round(lines.reduce((sum, line) => sum + line.scrap, 0)),
  };
}

export type ScrapApprovalState = 'none' | 'pending' | 'approved' | 'rejected' | 'stale';

/**
 * State of the excess-scrap approval of an order: the latest request decides;
 * scrap recorded after it (approved or rejected) needs a new review (`stale`).
 */
export function scrapApprovalState(
  approvals: ReadonlyArray<{ status: string; createdAt: Date }>,
  lastScrapRecordedAt: Date | null
): ScrapApprovalState {
  const latest = [...approvals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return 'none';
  if (latest.status === 'pending') return 'pending';
  const newer = Boolean(
    lastScrapRecordedAt && lastScrapRecordedAt.getTime() > latest.createdAt.getTime()
  );
  if (latest.status === 'approved') return newer ? 'stale' : 'approved';
  if (latest.status === 'rejected') return newer ? 'stale' : 'rejected';
  return 'none';
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export interface BalanceLineInput {
  zohoItemId: string;
  consumed: number;
  leftover: number;
  scrap: number;
  /** Net input per output unit; null when not comparable. */
  qtyPerOutput: number | null;
  /** Measurement tolerance of the item (percent). */
  tolerancePct: number;
}

export interface BalanceLine {
  zohoItemId: string;
  consumed: number;
  expectedUse: number | null;
  leftover: number;
  scrap: number;
  accounted: number | null;
  /** consumed − accounted (positive = material not accounted for). */
  difference: number | null;
  differencePct: number | null;
  tolerancePct: number;
  comparable: boolean;
  withinTolerance: boolean;
}

export interface MaterialBalance {
  lines: BalanceLine[];
  /** At least one line can be balanced. */
  comparable: boolean;
  /** Every comparable line is within its tolerance. */
  balanced: boolean;
  /** Σ positive differences of the comparable lines. */
  unaccounted: number;
}

export function computeMaterialBalance(input: {
  produced: number;
  /** Scrap of the output item (defective pieces): they used input material too. */
  outputScrap?: number;
  lines: readonly BalanceLineInput[];
}): MaterialBalance {
  const produced = Math.max(0, input.produced) + Math.max(0, input.outputScrap ?? 0);
  const lines: BalanceLine[] = input.lines.map((line) => {
    const consumed = Math.max(0, line.consumed);
    const leftover = Math.max(0, line.leftover);
    const scrap = Math.max(0, line.scrap);
    const tolerancePct = Math.max(0, line.tolerancePct);
    if (line.qtyPerOutput === null || !Number.isFinite(line.qtyPerOutput)) {
      return {
        zohoItemId: line.zohoItemId,
        consumed: round(consumed),
        expectedUse: null,
        leftover: round(leftover),
        scrap: round(scrap),
        accounted: null,
        difference: null,
        differencePct: null,
        tolerancePct,
        comparable: false,
        withinTolerance: true,
      };
    }
    const expectedUse = produced * Math.max(0, line.qtyPerOutput);
    const accounted = expectedUse + leftover + scrap;
    const difference = consumed - accounted;
    const reference = Math.max(consumed, accounted);
    const differencePct =
      reference <= EPS ? 0 : round((Math.abs(difference) / reference) * 100, 2);
    return {
      zohoItemId: line.zohoItemId,
      consumed: round(consumed),
      expectedUse: round(expectedUse),
      leftover: round(leftover),
      scrap: round(scrap),
      accounted: round(accounted),
      difference: round(difference),
      differencePct,
      tolerancePct,
      comparable: true,
      withinTolerance: Math.abs(difference) <= (reference * tolerancePct) / 100 + 1e-4,
    };
  });
  const comparable = lines.filter((line) => line.comparable);
  return {
    lines,
    comparable: comparable.length > 0,
    balanced: comparable.every((line) => line.withinTolerance),
    unaccounted: round(
      comparable.reduce((sum, line) => sum + Math.max(0, line.difference ?? 0), 0)
    ),
  };
}

/** Scrap still allowed for an input before crossing the tolerance. */
export function remainingScrapAllowance(consumed: number, scrap: number, allowancePct: number): number {
  return round(Math.max(0, (Math.max(0, consumed) * Math.max(0, allowancePct)) / 100 - Math.max(0, scrap)));
}
