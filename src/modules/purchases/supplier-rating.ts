/**
 * Supplier rating (plan 6.1, `supplier-rating.ts`).
 *
 * Every `SupplierEvaluation` scores 1–5 on time, quality, price and
 * communication. The rating of the supplier is the weighted average of the
 * evaluations with an exponential decay (half-life 180 days), so a recent bad
 * delivery weighs more than an old good one. Overall = 35 % on time + 35 %
 * quality + 20 % price + 10 % communication. Invalid scores are ignored.
 *
 * `supplierRiskFromRating` turns the rating into the risk used by the RFQ
 * scoring (0 = no risk, 1 = maximum), shrinking toward 0.5 while there are
 * fewer than three evaluations.
 *
 * Pure module.
 */

export const RATING_WEIGHTS = { onTime: 0.35, quality: 0.35, price: 0.2, communication: 0.1 } as const;
export const RATING_HALF_LIFE_DAYS = 180;
export const RATING_MIN_SCORE = 1;
export const RATING_MAX_SCORE = 5;
/** Evaluations needed before the rating fully decides the risk. */
export const RATING_CONFIDENT_COUNT = 3;

const DAY_MS = 86_400_000;

export interface EvaluationInput {
  onTime: number;
  quality: number;
  price: number;
  communication: number;
  createdAt: Date;
}

export interface SupplierRating {
  overall: number | null;
  onTime: number | null;
  quality: number | null;
  price: number | null;
  communication: number | null;
  /** Valid evaluations that took part. */
  count: number;
  lastEvaluatedAt: Date | null;
}

export function isValidScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RATING_MIN_SCORE &&
    value <= RATING_MAX_SCORE
  );
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Weight of an evaluation of `ageDays` (future dates count as today). */
export function decayWeight(ageDays: number, halfLifeDays = RATING_HALF_LIFE_DAYS): number {
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

export function computeSupplierRating(
  evaluations: readonly EvaluationInput[],
  now: Date = new Date()
): SupplierRating {
  const valid = evaluations.filter(
    (e) =>
      isValidScore(e.onTime) &&
      isValidScore(e.quality) &&
      isValidScore(e.price) &&
      isValidScore(e.communication) &&
      e.createdAt instanceof Date &&
      !Number.isNaN(e.createdAt.getTime())
  );
  if (valid.length === 0) {
    return {
      overall: null,
      onTime: null,
      quality: null,
      price: null,
      communication: null,
      count: 0,
      lastEvaluatedAt: null,
    };
  }
  let totalWeight = 0;
  const sums = { onTime: 0, quality: 0, price: 0, communication: 0 };
  let last = valid[0].createdAt;
  for (const evaluation of valid) {
    const weight = decayWeight((now.getTime() - evaluation.createdAt.getTime()) / DAY_MS);
    totalWeight += weight;
    sums.onTime += evaluation.onTime * weight;
    sums.quality += evaluation.quality * weight;
    sums.price += evaluation.price * weight;
    sums.communication += evaluation.communication * weight;
    if (evaluation.createdAt.getTime() > last.getTime()) last = evaluation.createdAt;
  }
  const onTime = sums.onTime / totalWeight;
  const quality = sums.quality / totalWeight;
  const price = sums.price / totalWeight;
  const communication = sums.communication / totalWeight;
  const overall =
    onTime * RATING_WEIGHTS.onTime +
    quality * RATING_WEIGHTS.quality +
    price * RATING_WEIGHTS.price +
    communication * RATING_WEIGHTS.communication;
  return {
    overall: round2(overall),
    onTime: round2(onTime),
    quality: round2(quality),
    price: round2(price),
    communication: round2(communication),
    count: valid.length,
    lastEvaluatedAt: last,
  };
}

/** 0 (reliable) … 1 (risky); 0.5 when unknown; shrinks toward 0.5 with few evaluations. */
export function supplierRiskFromRating(rating: number | null | undefined, evaluationsCount: number): number {
  if (rating === null || rating === undefined || !Number.isFinite(rating) || evaluationsCount <= 0) {
    return 0.5;
  }
  const clamped = Math.min(RATING_MAX_SCORE, Math.max(RATING_MIN_SCORE, rating));
  const base = (RATING_MAX_SCORE - clamped) / (RATING_MAX_SCORE - RATING_MIN_SCORE);
  const confidence = Math.min(1, evaluationsCount / RATING_CONFIDENT_COUNT);
  return Math.round((confidence * base + (1 - confidence) * 0.5) * 10_000) / 10_000;
}
