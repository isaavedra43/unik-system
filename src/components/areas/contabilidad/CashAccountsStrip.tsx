'use client';

import type { CashAccountDTO } from '@/modules/finance/finance-dto';
import { formatMoney } from '@/modules/areas/contabilidad/contabilidad-model';

export interface CashAccountsStripProps {
  accounts: readonly CashAccountDTO[];
  selectedId: string | null;
  onSelect: (accountId: string) => void;
  /** Disables the buttons while the book is loading. */
  busy?: boolean;
}

/**
 * Saldos de las cuentas de caja y banco (plan 7.6). Cada tarjeta es el botón
 * que abre el libro de esa cuenta, de modo que el saldo y sus movimientos nunca
 * quedan a dos clics de distancia.
 */
export function CashAccountsStrip({
  accounts,
  selectedId,
  onSelect,
  busy = false,
}: CashAccountsStripProps) {
  if (accounts.length === 0) {
    return (
      <div className="fin-empty">
        <strong>Sin cuentas de caja o banco</strong>
        <p>Crea la primera cuenta en Catálogos para empezar a registrar movimientos.</p>
      </div>
    );
  }

  return (
    <div className="fin-accounts" role="group" aria-label="Saldos por cuenta">
      {accounts.map((account) => {
        const selected = account.id === selectedId;
        const negative = Number(account.currentBalance) < 0;
        return (
          <button
            key={account.id}
            type="button"
            className="fin-account"
            aria-pressed={selected}
            disabled={busy}
            onClick={() => onSelect(account.id)}
            title={`Ver el libro de ${account.name}`}
          >
            <span className="fin-account-name">{account.name}</span>
            <span className={`fin-account-balance${negative ? ' fin-negative' : ''}`}>
              {formatMoney(account.currentBalance, account.currency)}
            </span>
            <span className="fin-account-meta">
              {account.kindLabel}
              {account.status === 'active' ? '' : ' · cerrada'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
