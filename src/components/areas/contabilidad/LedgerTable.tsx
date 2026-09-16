'use client';

import { Undo2 } from 'lucide-react';
import { Badge, Button } from '@/components/ui/primitives';
import type { CashBookResult, CashBookRow } from '@/modules/finance/cashflow-service';
import { formatDateKey, formatMoney } from '@/modules/areas/contabilidad/contabilidad-model';
import { LEDGER_ENTRY_KIND_LABELS, type LedgerEntryKind } from '@/modules/finance/types';
import { canReverseEntry, reverseBlockedReason } from './contabilidad-ui-model';

export interface LedgerTableProps {
  book: CashBookResult;
  /** `finance.post`: only then the "Revertir" button is offered. */
  canReverse: boolean;
  onReverse: (row: CashBookRow) => void;
  busy?: boolean;
}

function kindLabel(kind: string): string {
  return LEDGER_ENTRY_KIND_LABELS[kind as LedgerEntryKind] ?? kind;
}

/**
 * Renglones del libro de una cuenta con su saldo corrido (plan 7.6). En ≤768 px
 * la tabla se sustituye por la lista equivalente (CSS), sin scroll horizontal.
 *
 * "Revertir" sólo aparece en asientos manuales que nadie ha reversado: los
 * asientos de un gasto, una obligación o una nómina se corrigen desde su propio
 * flujo, y la tabla lo dice en vez de ofrecer un botón que el motor rechazaría.
 */
export function LedgerTable({ book, canReverse, onReverse, busy = false }: LedgerTableProps) {
  if (book.rows.length === 0) {
    return (
      <div className="fin-empty">
        <strong>Sin movimientos en este rango</strong>
        <p>
          La cuenta {book.account.name} no tuvo entradas ni salidas entre {formatDateKey(book.from)}{' '}
          y {formatDateKey(book.to)}.
        </p>
      </div>
    );
  }

  const currency = book.account.currency;

  return (
    <>
      <div className="fin-table-wrap">
        <table className="fin-table">
          <caption>
            {book.account.name}: saldo inicial {formatMoney(book.openingBalance, currency)} ·
            entradas {formatMoney(book.totalIn, currency)} · salidas{' '}
            {formatMoney(book.totalOut, currency)} · saldo final{' '}
            {formatMoney(book.closingBalance, currency)}
          </caption>
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Asiento</th>
              <th scope="col">Concepto</th>
              <th scope="col" className="fin-num">
                Entrada
              </th>
              <th scope="col" className="fin-num">
                Salida
              </th>
              <th scope="col" className="fin-num">
                Saldo
              </th>
              <th scope="col">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {book.rows.map((row) => {
              const reversible = canReverseEntry(row);
              return (
                <tr key={`${row.entryId}-${row.number}-${row.balance}`}>
                  <td>{formatDateKey(row.date)}</td>
                  <td>
                    <span className="fin-row-card-title">{row.number}</span>
                    <div className="fin-muted">{kindLabel(row.kind)}</div>
                  </td>
                  <td>
                    {row.description}
                    {row.memo ? <div className="fin-muted">{row.memo}</div> : null}
                    {row.reversedByEntryId ? <Badge variant="weak">Reversado</Badge> : null}
                    {row.reversesEntryId ? <Badge variant="weak">Es un reverso</Badge> : null}
                  </td>
                  <td className="fin-num">
                    {Number(row.debit) > 0 ? formatMoney(row.debit, currency) : '—'}
                  </td>
                  <td className="fin-num">
                    {Number(row.credit) > 0 ? formatMoney(row.credit, currency) : '—'}
                  </td>
                  <td className={`fin-num${Number(row.balance) < 0 ? ' fin-negative' : ''}`}>
                    {formatMoney(row.balance, currency)}
                  </td>
                  <td>
                    {canReverse && reversible ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => onReverse(row)}
                      >
                        <Undo2 size={14} aria-hidden="true" />
                        Revertir
                      </Button>
                    ) : canReverse ? (
                      <span className="fin-muted">{reverseBlockedReason(row.sourceType)}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="fin-cards" aria-label={`Movimientos de ${book.account.name}`}>
        {book.rows.map((row) => {
          const reversible = canReverse && canReverseEntry(row);
          const isIn = Number(row.debit) > 0;
          return (
            <li key={`card-${row.entryId}-${row.balance}`} className="fin-row-card">
              <span className="fin-row-card-head">
                <span className="fin-row-card-title">{row.description}</span>
                <span className={`fin-num${isIn ? '' : ' fin-negative'}`}>
                  {isIn
                    ? `+${formatMoney(row.debit, currency)}`
                    : `-${formatMoney(row.credit, currency)}`}
                </span>
              </span>
              <span className="fin-muted">
                {formatDateKey(row.date)} · {row.number} · {kindLabel(row.kind)} · saldo{' '}
                {formatMoney(row.balance, currency)}
              </span>
              {reversible ? (
                <span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onReverse(row)}
                  >
                    <Undo2 size={14} aria-hidden="true" />
                    Revertir
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
