'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { emptyItem, money, previewTotals, type QuoteItem } from './quotes-client';

/** Line items editor with live (client-side) totals; the server is authoritative. */
export function QuoteItemsEditor({
  items,
  currency,
  disabled,
  onChange,
}: {
  items: QuoteItem[];
  currency: string;
  disabled: boolean;
  onChange: (items: QuoteItem[]) => void;
}) {
  const totals = previewTotals(items);
  const update = (index: number, patch: Partial<QuoteItem>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  return (
    <div className="table-wrap">
      <table className="assistant-admin-table" aria-label="Partidas de la cotización">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Producto</th>
            <th>Descripción</th>
            <th style={{ textAlign: 'right' }}>Cantidad</th>
            <th style={{ textAlign: 'right' }}>Precio unitario</th>
            <th style={{ textAlign: 'right' }}>Impuesto</th>
            <th style={{ textAlign: 'right' }}>Importe</th>
            <th aria-label="Acciones" />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={8} className="assistant-admin-muted">
                Sin partidas. Agrega al menos una.
              </td>
            </tr>
          ) : null}
          {items.map((item, index) => {
            const line = item.quantity * item.unitPrice;
            return (
              <tr key={index}>
                <td>
                  <input
                    className="assistant-admin-filter-input"
                    value={item.sku ?? ''}
                    disabled={disabled}
                    aria-label={`SKU partida ${index + 1}`}
                    onChange={(e) => update(index, { sku: e.target.value || undefined })}
                    style={{ width: '7rem' }}
                  />
                </td>
                <td>
                  <input
                    className="assistant-admin-filter-input"
                    value={item.name}
                    disabled={disabled}
                    required
                    aria-label={`Producto partida ${index + 1}`}
                    onChange={(e) => update(index, { name: e.target.value })}
                    style={{ minWidth: '10rem' }}
                  />
                </td>
                <td>
                  <input
                    className="assistant-admin-filter-input"
                    value={item.description ?? ''}
                    disabled={disabled}
                    aria-label={`Descripción partida ${index + 1}`}
                    onChange={(e) => update(index, { description: e.target.value || undefined })}
                    style={{ minWidth: '10rem' }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    className="assistant-admin-filter-input"
                    type="number"
                    min={0.0001}
                    step="any"
                    value={item.quantity}
                    disabled={disabled}
                    aria-label={`Cantidad partida ${index + 1}`}
                    onChange={(e) => update(index, { quantity: Number(e.target.value) })}
                    style={{ width: '6rem', textAlign: 'right' }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    className="assistant-admin-filter-input"
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.unitPrice}
                    disabled={disabled}
                    aria-label={`Precio unitario partida ${index + 1}`}
                    onChange={(e) => update(index, { unitPrice: Number(e.target.value) })}
                    style={{ width: '7rem', textAlign: 'right' }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <select
                    className="assistant-admin-select"
                    value={String(item.taxRate)}
                    disabled={disabled}
                    aria-label={`Impuesto partida ${index + 1}`}
                    onChange={(e) => update(index, { taxRate: Number(e.target.value) })}
                  >
                    <option value="0">0 %</option>
                    <option value="0.08">8 %</option>
                    <option value="0.16">16 %</option>
                  </select>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(line * (1 + (item.taxRate ?? 0)), currency)}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Quitar partida ${index + 1}`}
                    disabled={disabled}
                    onClick={() => onChange(items.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6} style={{ textAlign: 'right' }}>
              Subtotal
            </td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {money(totals.subtotal, currency)}
            </td>
            <td />
          </tr>
          <tr>
            <td colSpan={6} style={{ textAlign: 'right' }}>
              Impuestos
            </td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {money(totals.tax, currency)}
            </td>
            <td />
          </tr>
          <tr>
            <td colSpan={6} style={{ textAlign: 'right', fontWeight: 600 }}>
              Total (estimado en pantalla)
            </td>
            <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {money(totals.total, currency)}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      {!disabled ? (
        <div style={{ padding: '0.5rem 0' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onChange([...items, emptyItem()])}
          >
            <Plus size={16} /> Agregar partida
          </button>
        </div>
      ) : null}
    </div>
  );
}
