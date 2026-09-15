import { describe, expect, it } from 'vitest';
import {
  computeMaterialBalance,
  evaluateScrap,
  remainingScrapAllowance,
  scrapApprovalState,
  scrapPct,
} from './scrap-rules';

describe('scrapPct', () => {
  it('is scrap over basis in percent', () => {
    expect(scrapPct(5, 100)).toBe(5);
    expect(scrapPct(1, 3)).toBe(33.33);
    expect(scrapPct(0, 0)).toBe(0);
    expect(scrapPct(2, 0)).toBeNull();
  });
});

describe('evaluateScrap', () => {
  const base = { allowancePct: 5, outputZohoItemId: 'placa', produced: 90 };

  it('stays within tolerance up to the allowance (inclusive)', () => {
    const result = evaluateScrap({ ...base, consumedByItem: { lamina: 100 }, scrapByItem: { lamina: 5 } });
    expect(result).toMatchObject({ exceeded: false, pending: false, maxPct: 5, totalScrap: 5 });
    expect(result.lines).toEqual([
      { zohoItemId: 'lamina', role: 'input', basis: 100, scrap: 5, pct: 5, exceeded: false, pending: false },
    ]);
  });

  it('exceeds when scrap / input is above the allowance', () => {
    const result = evaluateScrap({ ...base, consumedByItem: { lamina: 100 }, scrapByItem: { lamina: 8 } });
    expect(result).toMatchObject({ exceeded: true, maxPct: 8 });
  });

  it('judges each input on its own basis', () => {
    const result = evaluateScrap({
      ...base,
      consumedByItem: { lamina: 100, canto: 10 },
      scrapByItem: { lamina: 2, canto: 1 },
    });
    expect(result.lines.map((line) => [line.zohoItemId, line.pct, line.exceeded])).toEqual([
      ['canto', 10, true],
      ['lamina', 2, false],
    ]);
    expect(result.exceeded).toBe(true);
  });

  it('uses produced + scrap as the basis of defective finished goods', () => {
    const result = evaluateScrap({ ...base, produced: 95, consumedByItem: { lamina: 100 }, scrapByItem: { placa: 5 } });
    const output = result.lines.find((line) => line.zohoItemId === 'placa');
    expect(output).toMatchObject({ role: 'output', basis: 100, pct: 5, exceeded: false });
  });

  it('counts the scrap of a same-item transformation as input scrap', () => {
    const result = evaluateScrap({
      allowancePct: 3,
      outputZohoItemId: 'lamina',
      produced: 90,
      consumedByItem: { lamina: 100 },
      scrapByItem: { lamina: 4 },
    });
    expect(result.lines).toEqual([
      { zohoItemId: 'lamina', role: 'input', basis: 100, scrap: 4, pct: 4, exceeded: true, pending: false },
    ]);
  });

  it('does not judge scrap recorded before any consumption', () => {
    const result = evaluateScrap({ ...base, consumedByItem: { lamina: 0 }, scrapByItem: { lamina: 3 } });
    expect(result).toMatchObject({ exceeded: false, pending: true, maxPct: null });
  });
});

describe('scrapApprovalState', () => {
  const t = (iso: string) => new Date(iso);

  it('follows the latest request', () => {
    expect(scrapApprovalState([], null)).toBe('none');
    expect(scrapApprovalState([{ status: 'pending', createdAt: t('2026-09-15T10:00:00Z') }], null)).toBe('pending');
    expect(
      scrapApprovalState(
        [
          { status: 'rejected', createdAt: t('2026-09-15T09:00:00Z') },
          { status: 'approved', createdAt: t('2026-09-15T10:00:00Z') },
        ],
        t('2026-09-15T09:30:00Z')
      )
    ).toBe('approved');
    expect(scrapApprovalState([{ status: 'rejected', createdAt: t('2026-09-15T10:00:00Z') }], t('2026-09-15T09:00:00Z'))).toBe('rejected');
    expect(scrapApprovalState([{ status: 'expired', createdAt: t('2026-09-15T10:00:00Z') }], null)).toBe('none');
  });

  it('asks again when scrap was recorded after the last decision', () => {
    expect(scrapApprovalState([{ status: 'approved', createdAt: t('2026-09-15T10:00:00Z') }], t('2026-09-15T11:00:00Z'))).toBe('stale');
    expect(scrapApprovalState([{ status: 'rejected', createdAt: t('2026-09-15T10:00:00Z') }], t('2026-09-15T11:00:00Z'))).toBe('stale');
  });
});

describe('computeMaterialBalance', () => {
  it('balances consumed = produced + leftover + scrap for the same measure', () => {
    const balance = computeMaterialBalance({
      produced: 90,
      lines: [{ zohoItemId: 'lamina', consumed: 100, leftover: 4, scrap: 6, qtyPerOutput: 1, tolerancePct: 2 }],
    });
    expect(balance).toMatchObject({ comparable: true, balanced: true, unaccounted: 0 });
    expect(balance.lines[0]).toMatchObject({ expectedUse: 90, accounted: 100, difference: 0, differencePct: 0, withinTolerance: true });
  });

  it('reports material that nobody accounted for', () => {
    const balance = computeMaterialBalance({
      produced: 80,
      lines: [{ zohoItemId: 'lamina', consumed: 100, leftover: 4, scrap: 6, qtyPerOutput: 1, tolerancePct: 2 }],
    });
    expect(balance).toMatchObject({ balanced: false, unaccounted: 10 });
    expect(balance.lines[0]).toMatchObject({ difference: 10, differencePct: 10, withinTolerance: false });
  });

  it('accepts differences within the measurement tolerance, in both directions', () => {
    const over = computeMaterialBalance({
      produced: 91.5,
      lines: [{ zohoItemId: 'lamina', consumed: 100, leftover: 4, scrap: 6, qtyPerOutput: 1, tolerancePct: 2 }],
    });
    expect(over.balanced).toBe(true);
    expect(over.lines[0].difference).toBe(-1.5);
    const under = computeMaterialBalance({
      produced: 87,
      lines: [{ zohoItemId: 'lamina', consumed: 100, leftover: 4, scrap: 6, qtyPerOutput: 1, tolerancePct: 2 }],
    });
    expect(under.balanced).toBe(false);
  });

  it('uses the BOM ratio and ignores lines without a ratio', () => {
    const balance = computeMaterialBalance({
      produced: 10,
      lines: [
        { zohoItemId: 'tornillo', consumed: 42, leftover: 0, scrap: 2, qtyPerOutput: 4, tolerancePct: 0 },
        { zohoItemId: 'pintura', consumed: 3, leftover: 0, scrap: 0, qtyPerOutput: null, tolerancePct: 2 },
      ],
    });
    expect(balance).toMatchObject({ comparable: true, balanced: true });
    expect(balance.lines[1]).toMatchObject({ comparable: false, withinTolerance: true, difference: null });
    expect(computeMaterialBalance({ produced: 1, lines: [balance.lines[1] as never] }).comparable).toBe(false);
  });

  it('is balanced when nothing moved yet', () => {
    const balance = computeMaterialBalance({
      produced: 0,
      lines: [{ zohoItemId: 'lamina', consumed: 0, leftover: 0, scrap: 0, qtyPerOutput: 1, tolerancePct: 0 }],
    });
    expect(balance).toMatchObject({ comparable: true, balanced: true, unaccounted: 0 });
  });
});

describe('remainingScrapAllowance', () => {
  it('is the scrap still allowed before crossing the tolerance', () => {
    expect(remainingScrapAllowance(200, 4, 5)).toBe(6);
    expect(remainingScrapAllowance(100, 9, 5)).toBe(0);
  });
});

describe('balance with defective output pieces', () => {
  it('counts the input used by scrapped output pieces', () => {
    const line = { zohoItemId: 'lamina', consumed: 10, leftover: 0, scrap: 0, qtyPerOutput: 1, tolerancePct: 1 };
    const without = computeMaterialBalance({ produced: 9.8, lines: [line] });
    expect(without.balanced).toBe(false);
    const withScrap = computeMaterialBalance({ produced: 9.8, outputScrap: 0.2, lines: [line] });
    expect(withScrap.lines[0]).toMatchObject({ expectedUse: 10, difference: 0, withinTolerance: true });
    expect(withScrap.balanced).toBe(true);
    expect(computeMaterialBalance({ produced: 9.8, outputScrap: -1, lines: [line] }).lines[0].expectedUse).toBe(9.8);
  });
});
