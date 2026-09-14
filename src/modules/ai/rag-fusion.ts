/**
 * Reciprocal Rank Fusion (RRF) — merges several ranked lists (lexical,
 * semantic) into one without needing comparable scores. Pure.
 */
export interface RankedEntry<T> {
  key: string;
  item: T;
}

export interface FusedEntry<T> {
  key: string;
  item: T;
  score: number;
  /** Indexes of the input lists that contained the key. */
  sources: number[];
}

export function reciprocalRankFusion<T>(lists: Array<RankedEntry<T>[]>, k = 60): FusedEntry<T>[] {
  const acc = new Map<string, FusedEntry<T>>();
  lists.forEach((list, listIndex) => {
    list.forEach((entry, rank) => {
      const contribution = 1 / (k + rank + 1);
      const existing = acc.get(entry.key);
      if (existing) {
        existing.score += contribution;
        if (!existing.sources.includes(listIndex)) existing.sources.push(listIndex);
      } else {
        acc.set(entry.key, { key: entry.key, item: entry.item, score: contribution, sources: [listIndex] });
      }
    });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
