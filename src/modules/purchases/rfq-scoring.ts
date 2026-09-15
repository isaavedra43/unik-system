import { supplierRiskFromRating } from './supplier-rating';

/**
 * Landed cost and scoring of RFQ responses (plan 6.1, `rfq-scoring.ts`).
 *
 * Landed unit cost per RFQ line unit (plan formula, with the factor of the
 * quoted unit and the freight/other costs spread by merchandise value):
 *
 *   landed = (price · unitsPerRfqUnit + freightShare/qty + otherShare/qty)
 *            · (taxIncluded ? 1 : 1 + taxRate) · exchangeRate
 *
 * `unitsPerRfqUnit` = quoted units that make one unit of the RFQ line (a box
 * of 1.44 m² quoted against an RFQ in m² → 1/1.44). The requested quantity of
 * the RFQ line is used for every supplier so the comparison is fair. A missing
 * tax rate with prices without tax assumes 16 % (flagged); a foreign currency
 * without exchange rate makes the response not comparable.
 *
 * Score (0–1) = 0.50 cost + 0.25 lead time + 0.15 (1 − risk) + 0.10 specification:
 * - cost: per RFQ line, best landed unit cost / this landed unit cost, weighted
 *   by the value of the line; a line not quoted scores 0;
 * - time: (min lead + 1) / (lead + 1); unknown lead = 0.5;
 * - risk: supplier rating, new candidate, low interpretation confidence,
 *   expired validity, not comparable;
 * - spec: share of RFQ lines quoted for the full requested quantity.
 *
 * Pure module.
 */

export const RFQ_SCORE_WEIGHTS = { cost: 0.5, time: 0.25, risk: 0.15, spec: 0.1 } as const;
export const DEFAULT_TAX_RATE = 0.16;
export const BASE_CURRENCY = 'MXN';
export const LOW_CONFIDENCE = 0.75;

export interface ScoringRfqLine {
  id: string;
  qty: number;
  unit: string;
  description?: string;
}

export interface ScoringResponseLine {
  rfqLineId: string;
  /** Price of one quoted unit. */
  unitPrice: number;
  /** Quoted quantity in the quoted unit (null = not stated, assumed the requested one). */
  qty: number | null;
  unit: string | null;
  /** Quoted units per RFQ line unit; null when the units could not be reconciled. */
  unitsPerRfqUnit: number | null;
}

export interface ScoringResponse {
  id: string;
  currency: string;
  exchangeRate: number | null;
  taxIncluded: boolean;
  taxRate: number | null;
  freight: number;
  otherCosts: number;
  leadTimeDays: number | null;
  validUntil: Date | null;
  /** Interpretation confidence (null for manual/confirmed responses). */
  confidence: number | null;
  supplierRating: number | null;
  evaluationsCount: number;
  /** Quoted by a sourcing candidate that is not a supplier yet. */
  isCandidate: boolean;
  lines: ScoringResponseLine[];
}

export interface LineLandedCost {
  rfqLineId: string;
  quoted: boolean;
  /** Price per RFQ unit before freight, tax and currency. */
  pricePerRfqUnit: number | null;
  landedUnitCost: number | null;
  /** Requested quantity of the RFQ line covered by the quote (in RFQ units). */
  coveredQty: number;
  issues: string[];
}

export interface LandedCostResult {
  lines: LineLandedCost[];
  /** Σ landed unit cost × requested qty over comparable quoted lines; null when nothing is comparable. */
  landedTotal: number | null;
  comparable: boolean;
  issues: string[];
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const positiveOrZero = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export function computeLandedCosts(
  rfqLines: readonly ScoringRfqLine[],
  response: ScoringResponse,
  options: { defaultTaxRate?: number; baseCurrency?: string } = {}
): LandedCostResult {
  const issues: string[] = [];
  const baseCurrency = options.baseCurrency ?? BASE_CURRENCY;
  let fx: number | null = 1;
  if (response.currency !== baseCurrency) {
    fx = response.exchangeRate && response.exchangeRate > 0 ? response.exchangeRate : null;
    if (fx === null) issues.push(`Falta el tipo de cambio de ${response.currency} a ${baseCurrency}`);
  }
  let taxFactor = 1;
  if (!response.taxIncluded) {
    const rate =
      response.taxRate !== null && Number.isFinite(response.taxRate) && response.taxRate >= 0
        ? response.taxRate
        : null;
    if (rate === null) {
      const assumed = options.defaultTaxRate ?? DEFAULT_TAX_RATE;
      issues.push(`IVA no indicado: se supone ${Math.round(assumed * 100)} %`);
      taxFactor = 1 + assumed;
    } else {
      taxFactor = 1 + rate;
    }
  }

  const priced = rfqLines.map((line) => {
    const quote = response.lines.find((l) => l.rfqLineId === line.id);
    if (!quote) return { line, quote: null, pricePerRfqUnit: null as number | null, issue: null as string | null };
    if (!(quote.unitPrice >= 0) || !Number.isFinite(quote.unitPrice)) {
      return { line, quote, pricePerRfqUnit: null, issue: 'Precio inválido' };
    }
    if (quote.unitsPerRfqUnit === null || !(quote.unitsPerRfqUnit > 0)) {
      return {
        line,
        quote,
        pricePerRfqUnit: null,
        issue: `No se pudo convertir ${quote.unit ?? 'la unidad cotizada'} a ${line.unit}`,
      };
    }
    return { line, quote, pricePerRfqUnit: quote.unitPrice * quote.unitsPerRfqUnit, issue: null };
  });

  const merchandise = priced.reduce(
    (sum, p) => sum + (p.pricePerRfqUnit !== null ? p.pricePerRfqUnit * p.line.qty : 0),
    0
  );
  const freight = positiveOrZero(response.freight);
  const other = positiveOrZero(response.otherCosts);

  let landedTotal = 0;
  let comparableLines = 0;
  const lines: LineLandedCost[] = priced.map((p) => {
    const lineIssues = p.issue ? [p.issue] : [];
    if (!p.quote) {
      return {
        rfqLineId: p.line.id,
        quoted: false,
        pricePerRfqUnit: null,
        landedUnitCost: null,
        coveredQty: 0,
        issues: ['Sin cotizar'],
      };
    }
    let coveredQty = p.line.qty;
    if (p.quote.qty !== null && p.quote.unitsPerRfqUnit && p.quote.unitsPerRfqUnit > 0) {
      coveredQty = Math.min(p.line.qty, p.quote.qty / p.quote.unitsPerRfqUnit);
      if (coveredQty + 1e-9 < p.line.qty) {
        lineIssues.push(`Cotiza ${round4(coveredQty)} de ${p.line.qty} ${p.line.unit}`);
      }
    }
    if (p.pricePerRfqUnit === null || fx === null || !(p.line.qty > 0)) {
      return {
        rfqLineId: p.line.id,
        quoted: true,
        pricePerRfqUnit: p.pricePerRfqUnit === null ? null : round4(p.pricePerRfqUnit),
        landedUnitCost: null,
        coveredQty: round4(coveredQty),
        issues: lineIssues,
      };
    }
    const lineValue = p.pricePerRfqUnit * p.line.qty;
    const share = merchandise > 0 ? lineValue / merchandise : 0;
    const landed =
      (p.pricePerRfqUnit + (freight * share) / p.line.qty + (other * share) / p.line.qty) * taxFactor * fx;
    landedTotal += landed * p.line.qty;
    comparableLines += 1;
    return {
      rfqLineId: p.line.id,
      quoted: true,
      pricePerRfqUnit: round4(p.pricePerRfqUnit),
      landedUnitCost: round4(landed),
      coveredQty: round4(coveredQty),
      issues: lineIssues,
    };
  });

  const comparable = comparableLines > 0;
  return {
    lines,
    landedTotal: comparable ? round4(landedTotal) : null,
    comparable,
    issues,
  };
}

export interface ResponseScore {
  responseId: string;
  score: number;
  costScore: number;
  timeScore: number;
  risk: number;
  specMatch: number;
  landedTotal: number | null;
  comparable: boolean;
  rank: number;
  recommended: boolean;
  landed: LandedCostResult;
  reasons: string[];
}

export function scoreRfqResponses(
  rfqLines: readonly ScoringRfqLine[],
  responses: readonly ScoringResponse[],
  options: { now?: Date; weights?: typeof RFQ_SCORE_WEIGHTS; defaultTaxRate?: number } = {}
): ResponseScore[] {
  if (responses.length === 0) return [];
  const now = options.now ?? new Date();
  const weights = options.weights ?? RFQ_SCORE_WEIGHTS;
  const landed = new Map(
    responses.map((r) => [r.id, computeLandedCosts(rfqLines, r, { defaultTaxRate: options.defaultTaxRate })])
  );

  // Best landed unit cost per line and the value weight of the line.
  const best = new Map<string, number>();
  for (const line of rfqLines) {
    for (const response of responses) {
      const cost = landed.get(response.id)!.lines.find((l) => l.rfqLineId === line.id)?.landedUnitCost;
      if (cost !== null && cost !== undefined && cost > 0) {
        best.set(line.id, Math.min(best.get(line.id) ?? Number.POSITIVE_INFINITY, cost));
      }
    }
  }
  const lineWeight = new Map(
    rfqLines.map((line) => [line.id, best.has(line.id) ? best.get(line.id)! * Math.max(line.qty, 0) : 0])
  );
  const totalWeight = [...lineWeight.values()].reduce((a, b) => a + b, 0);

  const leads = responses
    .map((r) => r.leadTimeDays)
    .filter((lead): lead is number => typeof lead === 'number' && lead >= 0);
  const minLead = leads.length > 0 ? Math.min(...leads) : null;

  const scored = responses.map((response) => {
    const result = landed.get(response.id)!;
    const reasons = [...result.issues];

    let costScore = 0;
    if (totalWeight > 0) {
      for (const line of rfqLines) {
        const weight = lineWeight.get(line.id) ?? 0;
        if (weight <= 0) continue;
        const cost = result.lines.find((l) => l.rfqLineId === line.id)?.landedUnitCost;
        if (cost && cost > 0) costScore += (best.get(line.id)! / cost) * weight;
      }
      costScore /= totalWeight;
    }

    const timeScore =
      response.leadTimeDays === null || response.leadTimeDays < 0 || minLead === null
        ? 0.5
        : (minLead + 1) / (response.leadTimeDays + 1);
    if (response.leadTimeDays === null) reasons.push('Sin tiempo de entrega');

    let risk = supplierRiskFromRating(response.supplierRating, response.evaluationsCount);
    if (response.isCandidate) {
      risk += 0.25;
      reasons.push('Proveedor nuevo (candidato)');
    }
    if (response.confidence !== null && response.confidence < LOW_CONFIDENCE) {
      risk += 0.15;
      reasons.push('Interpretación con baja confianza');
    }
    if (response.validUntil && response.validUntil.getTime() < now.getTime()) {
      risk += 0.2;
      reasons.push('Cotización vencida');
    }
    if (!result.comparable) risk += 0.1;
    risk = Math.min(1, Math.max(0, risk));

    const specMatch =
      rfqLines.length === 0
        ? 0
        : rfqLines.reduce((sum, line) => {
            const covered = result.lines.find((l) => l.rfqLineId === line.id);
            if (!covered?.quoted || !(line.qty > 0)) return sum;
            return sum + Math.min(1, covered.coveredQty / line.qty);
          }, 0) / rfqLines.length;

    const score =
      weights.cost * costScore + weights.time * timeScore + weights.risk * (1 - risk) + weights.spec * specMatch;
    return {
      responseId: response.id,
      score: round4(score),
      costScore: round4(costScore),
      timeScore: round4(timeScore),
      risk: round4(risk),
      specMatch: round4(specMatch),
      landedTotal: result.landedTotal,
      comparable: result.comparable,
      rank: 0,
      recommended: false,
      landed: result,
      reasons,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const la = a.landedTotal ?? Number.POSITIVE_INFINITY;
    const lb = b.landedTotal ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.responseId.localeCompare(b.responseId);
  });
  scored.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  const top = scored.find((entry) => entry.comparable);
  if (top) top.recommended = true;
  return scored;
}
