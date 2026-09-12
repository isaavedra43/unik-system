'use client';

import React, { useState } from 'react';
import { Calculator, Plus, Trash2 } from 'lucide-react';
import { api, money, type QuoteScenario, type ScenarioTotals } from './quotes-client';

interface Comparison {
  currency: string;
  base: ScenarioTotals;
  scenarios: ScenarioTotals[];
}

/** What-if scenarios compared against the current quote (never persisted). */
export function QuoteScenarioSimulator({ quoteId }: { quoteId: string }) {
  const [scenarios, setScenarios] = useState<QuoteScenario[]>([
    { name: '5 % de descuento', discountPct: 5 },
    { name: 'Doble volumen', quantityMultiplier: 2 },
  ]);
  const [result, setResult] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<QuoteScenario>) =>
    setScenarios((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const clean = scenarios
        .filter((s) => s.name.trim())
        .map((s) => ({
          name: s.name.trim(),
          ...(s.discountPct !== undefined && !Number.isNaN(s.discountPct)
            ? { discountPct: s.discountPct }
            : {}),
          ...(s.quantityMultiplier !== undefined && !Number.isNaN(s.quantityMultiplier)
            ? { quantityMultiplier: s.quantityMultiplier }
            : {}),
          ...(s.taxRate !== undefined && !Number.isNaN(s.taxRate) ? { taxRate: s.taxRate } : {}),
        }));
      setResult(
        await api<Comparison>(`/app/quotes/api/quotes/${quoteId}/simulate`, {
          method: 'POST',
          body: JSON.stringify({ scenarios: clean }),
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo simular');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Simulador de escenarios">
      <h3 style={{ marginTop: 0 }}>Simulación de escenarios comerciales</h3>
      <p className="assistant-admin-muted">
        Compara descuentos, volumen y tasas de impuesto sin modificar la cotización.
      </p>
      <div className="table-wrap">
        <table className="assistant-admin-table">
          <thead>
            <tr>
              <th>Escenario</th>
              <th>Descuento %</th>
              <th>Multiplicador de cantidad</th>
              <th>Tasa de impuesto</th>
              <th aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="assistant-admin-filter-input"
                    value={s.name}
                    aria-label={`Nombre escenario ${i + 1}`}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="assistant-admin-filter-input"
                    type="number"
                    min={0}
                    max={100}
                    step="0.5"
                    value={s.discountPct ?? ''}
                    aria-label={`Descuento escenario ${i + 1}`}
                    onChange={(e) =>
                      update(i, {
                        discountPct: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    style={{ width: '6rem' }}
                  />
                </td>
                <td>
                  <input
                    className="assistant-admin-filter-input"
                    type="number"
                    min={0.01}
                    step="0.5"
                    value={s.quantityMultiplier ?? ''}
                    aria-label={`Multiplicador escenario ${i + 1}`}
                    onChange={(e) =>
                      update(i, {
                        quantityMultiplier:
                          e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    style={{ width: '6rem' }}
                  />
                </td>
                <td>
                  <select
                    className="assistant-admin-select"
                    value={s.taxRate === undefined ? '' : String(s.taxRate)}
                    aria-label={`Impuesto escenario ${i + 1}`}
                    onChange={(e) =>
                      update(i, {
                        taxRate: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  >
                    <option value="">Sin cambio</option>
                    <option value="0">0 %</option>
                    <option value="0.08">8 %</option>
                    <option value="0.16">16 %</option>
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Quitar escenario ${i + 1}`}
                    onClick={() => setScenarios((p) => p.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={scenarios.length >= 10}
          onClick={() => setScenarios((p) => [...p, { name: `Escenario ${p.length + 1}` }])}
        >
          <Plus size={16} /> Agregar escenario
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || scenarios.length === 0}
          onClick={run}
        >
          <Calculator size={16} /> {busy ? 'Calculando…' : 'Comparar'}
        </button>
      </div>
      {error ? (
        <div className="alert alert-error" role="alert" style={{ marginTop: '0.5rem' }}>
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
          <table className="assistant-admin-table" aria-label="Comparativa de escenarios">
            <thead>
              <tr>
                <th>Escenario</th>
                <th style={{ textAlign: 'right' }}>Subtotal</th>
                <th style={{ textAlign: 'right' }}>Impuestos</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ textAlign: 'right' }}>Diferencia</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ fontWeight: 600 }}>
                <td>{result.base.name}</td>
                <td style={{ textAlign: 'right' }}>
                  {money(result.base.subtotal, result.currency)}
                </td>
                <td style={{ textAlign: 'right' }}>{money(result.base.tax, result.currency)}</td>
                <td style={{ textAlign: 'right' }}>{money(result.base.total, result.currency)}</td>
                <td style={{ textAlign: 'right' }}>—</td>
              </tr>
              {result.scenarios.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td style={{ textAlign: 'right' }}>{money(s.subtotal, result.currency)}</td>
                  <td style={{ textAlign: 'right' }}>{money(s.tax, result.currency)}</td>
                  <td style={{ textAlign: 'right' }}>{money(s.total, result.currency)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {money(s.deltaTotal ?? '0', result.currency)} ({s.deltaPct} %)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
