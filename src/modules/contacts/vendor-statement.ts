/**
 * Vendor statement ("estado de cuenta del proveedor"), pure.
 *
 * UNIK's flow: a purchase order is created; when goods arrive the vendor's bill is registered
 * (a CHARGE we owe) and the payment is recorded as a vendor credit (an ABATEMENT). So the real
 * balance is bills − credits, in chronological order, exactly like Zoho's statement:
 *   opening balance = every countable bill − credit dated BEFORE the period,
 *   then one row per document inside the period with a running balance.
 * With no period the statement starts at the first document and the opening balance is 0.
 */

export interface StatementDocument {
  id: string;
  kind: 'bill' | 'credit';
  number: string | null;
  status: string | null;
  /** ISO date (UTC midnight for Zoho dates). */
  date: string | null;
  dueDate: string | null;
  total: string | null;
  balance: string | null;
  notes: string | null;
  href: string;
}

export interface StatementRow extends StatementDocument {
  /** Signed effect on what we owe: + for a bill, − for a credit. */
  amount: number;
  runningBalance: number;
}

export interface VendorStatement {
  from: string | null;
  to: string | null;
  openingBalance: number;
  billsTotal: number;
  billsCount: number;
  creditsTotal: number;
  creditsCount: number;
  closingBalance: number;
  rows: StatementRow[];
  /** Documents left out because they don't count (draft / cancelled / void). */
  excluded: number;
  firstDocumentDate: string | null;
}

const NON_COUNTABLE = new Set(['draft', 'cancelled', 'void']);

const num = (v: string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

function counts(doc: StatementDocument): boolean {
  return !NON_COUNTABLE.has((doc.status ?? '').trim().toLowerCase());
}

function dateKey(doc: StatementDocument): string {
  return doc.date ? doc.date.slice(0, 10) : '';
}

/** `from`/`to` are 'YYYY-MM-DD' (inclusive) or null for open ends. */
export function buildVendorStatement(
  documents: StatementDocument[],
  range: { from?: string | null; to?: string | null } = {}
): VendorStatement {
  const from = range.from?.trim() || null;
  const to = range.to?.trim() || null;

  const countable = documents.filter(counts);
  const excluded = documents.length - countable.length;
  const sorted = [...countable].sort((a, b) => {
    const d = dateKey(a).localeCompare(dateKey(b));
    if (d !== 0) return d;
    // Same day: charges before abatements, then folio.
    if (a.kind !== b.kind) return a.kind === 'bill' ? -1 : 1;
    return (a.number ?? '').localeCompare(b.number ?? '', undefined, { numeric: true });
  });

  let opening = 0;
  const inRange: StatementDocument[] = [];
  for (const doc of sorted) {
    const day = dateKey(doc);
    const signed = doc.kind === 'bill' ? num(doc.total) : -num(doc.total);
    if (from && day < from) {
      opening += signed;
      continue;
    }
    if (to && day > to) continue;
    inRange.push(doc);
  }

  let running = round2(opening);
  let billsTotal = 0;
  let creditsTotal = 0;
  let billsCount = 0;
  let creditsCount = 0;
  const rows: StatementRow[] = inRange.map((doc) => {
    const amount = doc.kind === 'bill' ? num(doc.total) : -num(doc.total);
    if (doc.kind === 'bill') {
      billsTotal += num(doc.total);
      billsCount += 1;
    } else {
      creditsTotal += num(doc.total);
      creditsCount += 1;
    }
    running = round2(running + amount);
    return { ...doc, amount: round2(amount), runningBalance: running };
  });

  return {
    from,
    to,
    openingBalance: round2(opening),
    billsTotal: round2(billsTotal),
    billsCount,
    creditsTotal: round2(creditsTotal),
    creditsCount,
    closingBalance: running,
    rows,
    excluded,
    firstDocumentDate: sorted[0]?.date ?? null,
  };
}

export type StatementPreset = 'all' | 'this_month' | 'last_month' | 'this_year' | 'last_90_days' | 'custom';

/** Date range for a preset, in America/Mexico_City calendar days. */
export function presetRange(preset: StatementPreset, now = new Date()): { from: string | null; to: string | null } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  switch (preset) {
    case 'this_month':
      return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
    case 'last_month': {
      const pm = m === 1 ? 12 : m - 1;
      const py = m === 1 ? y - 1 : y;
      return { from: iso(py, pm, 1), to: iso(py, pm, lastDay(py, pm)) };
    }
    case 'this_year':
      return { from: iso(y, 1, 1), to: iso(y, 12, 31) };
    case 'last_90_days': {
      const start = new Date(Date.UTC(y, m - 1, d) - 89 * 86_400_000);
      return { from: start.toISOString().slice(0, 10), to: iso(y, m, d) };
    }
    default:
      return { from: null, to: null };
  }
}

export function isIsoDay(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
