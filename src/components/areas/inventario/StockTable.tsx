'use client';

import '@/styles/operations/inventario.css';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { EmptyState } from '@/components/ui/composite';
import { Badge, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { StockByConfidenceRow } from '@/modules/inventory/inventory-queries';
import { CONFIDENCE_LABELS, type ConfidenceLevel } from '@/modules/inventory/inventory-types';
import { StockActionsDialog } from './StockActionsDialog';
import {
  CONFIDENCE_ORDER,
  INVENTORY_SPACES,
  confidenceTone,
  expectedSupplyText,
  formatQty,
  inventoryHref,
  profileHref,
  stalenessLabel,
  type ExpectedSupplySummary,
} from './inventario-model';

/**
 * Existencias por artículo (plan 7.6): confianza, conocido, disponible y
 * reservado del inventario propio, con las cifras de Zoho como columna
 * informativa que nunca entra en las fórmulas.
 *
 * The filters live in the URL, so a view is shareable and the back button
 * works; the rows are rendered by the server and this component only drives
 * the filters and the pagination.
 */

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

export interface StockTableQuery {
  q: string;
  bodega: string;
  confianza: string;
  page: number;
}

export interface StockTableProps {
  rows: StockByConfidenceRow[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
  query: StockTableQuery;
  warehouses: Array<{ id: string; name: string }>;
  /**
   * Lo que los proveedores todavía deben, por artículo (`summarizeExpectedSupply`).
   * Se muestra en su propia columna: NUNCA se suma a lo conocido ni a lo disponible.
   */
  expectedByItem?: Record<string, ExpectedSupplySummary>;
  /** Days without a count after which the last count is highlighted. */
  now: string;
  /**
   * Área key of the workspace, for the capture panel of a movement (it reads
   * the rows of the article through the area API).
   */
  areaKey?: string;
  /**
   * The person may register a movement, an adjustment, a block or a legacy
   * claim. The button only appears for them; the commands check the same keys
   * again inside their transaction.
   */
  canCapture?: boolean;
}

function daysSince(iso: string | null, now: string): number | null {
  if (!iso) return null;
  const from = Date.parse(iso);
  const to = Date.parse(now);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

export function StockTable({
  rows,
  pagination,
  query,
  warehouses,
  expectedByItem = {},
  now,
  areaKey = 'inventario',
  canCapture = false,
}: StockTableProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(query.q);
  const [warehouse, setWarehouse] = useState(query.bodega);
  const [confidence, setConfidence] = useState(query.confianza);
  const [capturing, setCapturing] = useState<StockByConfidenceRow | null>(null);

  const go = useMemo(
    () => (next: Partial<StockTableQuery>) => {
      const merged = { q: search, bodega: warehouse, confianza: confidence, page: 1, ...next };
      startTransition(() => {
        router.push(
          inventoryHref(INVENTORY_SPACES.stock, {
            q: merged.q || null,
            bodega: merged.bodega || null,
            confianza: merged.confianza || null,
            page: merged.page > 1 ? merged.page : null,
          })
        );
      });
    },
    [router, search, warehouse, confidence]
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    go({});
  }

  return (
    <div className="area-space">
      <form className="inv-toolbar" onSubmit={onSubmit} role="search">
        <FormField label="Buscar" htmlFor="inv-stock-search">
          <Input
            id="inv-stock-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nombre o SKU del artículo…"
            leftIcon={<Search size={14} aria-hidden="true" />}
            autoComplete="off"
          />
        </FormField>

        <FormField label="Bodega" htmlFor="inv-stock-warehouse">
          <Select
            id="inv-stock-warehouse"
            value={warehouse}
            onChange={(event) => {
              setWarehouse(event.target.value);
              go({ bodega: event.target.value });
            }}
          >
            <option value="">Todas</option>
            {warehouses.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Confianza" htmlFor="inv-stock-confidence">
          <Select
            id="inv-stock-confidence"
            value={confidence}
            onChange={(event) => {
              setConfidence(event.target.value);
              go({ confianza: event.target.value });
            }}
          >
            <option value="">Todas</option>
            {CONFIDENCE_ORDER.map((level) => (
              <option key={level} value={level}>
                {CONFIDENCE_LABELS[level]}
              </option>
            ))}
          </Select>
        </FormField>

        <div className="inv-toolbar-spacer" />
        <Button type="submit" size="sm" variant="secondary" isLoading={pending}>
          Aplicar
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          icon="search"
          title="Sin existencias con estos filtros"
          message="Cambia la bodega o el nivel de confianza. Si el artículo nunca se ha contado, aparecerá en cuanto se capture su primer conteo."
        />
      ) : (
        <>
          <div className="inv-table-wrap">
            <table className="inv-table">
              <caption className="sr-only">
                Existencias por artículo con su nivel de confianza
              </caption>
              <thead>
                <tr>
                  <th scope="col">Artículo</th>
                  <th scope="col">Confianza</th>
                  <th scope="col" className="inv-num">
                    Conocido
                  </th>
                  <th scope="col" className="inv-num">
                    Disponible
                  </th>
                  <th scope="col" className="inv-num">
                    Reservado
                  </th>
                  <th scope="col" className="inv-num">
                    Bloqueado
                  </th>
                  <th scope="col" className="inv-num">
                    Por llegar
                  </th>
                  <th scope="col">Último conteo</th>
                  <th scope="col" className="inv-num">
                    Zoho (informativo)
                  </th>
                  <th scope="col">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const stale = daysSince(row.lastCountAt, now);
                  return (
                    <tr key={row.profileId}>
                      <th scope="row">
                        <span className="inv-list-main">
                          <span>{row.productName ?? row.sku ?? row.zohoItemId}</span>
                          <span className="inv-list-sub">
                            {[row.sku, row.baseUnit].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </th>
                      <td>
                        <Badge
                          variant={BADGE_BY_TONE[confidenceTone(row.confidence as ConfidenceLevel)]}
                        >
                          {row.confidenceLabel}
                        </Badge>
                      </td>
                      <td className="inv-num">{formatQty(row.known)}</td>
                      <td className="inv-num">{formatQty(row.available)}</td>
                      <td className="inv-num">{formatQty(row.reserved)}</td>
                      <td className="inv-num">{formatQty(row.blocked)}</td>
                      <td
                        className="inv-num"
                        title="Comprado y todavía no recibido: es material esperado, nunca disponible"
                      >
                        {expectedSupplyText(expectedByItem[row.zohoItemId], row.baseUnit)}
                        {expectedByItem[row.zohoItemId]?.overdue ? (
                          <span className="inv-list-sub">Con atraso</span>
                        ) : null}
                      </td>
                      <td>{stalenessLabel(stale)}</td>
                      <td className="inv-num inv-zoho">
                        {row.zohoAvailableStock === null ? '—' : formatQty(row.zohoAvailableStock)}
                      </td>
                      <td>
                        <span className="inv-row-actions">
                          {canCapture ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setCapturing(row)}
                              title="Entrada, salida, traspaso, ajuste, bloqueo o compromiso previo al corte"
                            >
                              Registrar
                            </Button>
                          ) : null}
                          <Link className="btn btn-ghost btn-sm" href={profileHref(row.zohoItemId)}>
                            Perfil
                          </Link>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="inv-pagination">
            <span>
              {pagination.total.toLocaleString('es-MX')}{' '}
              {pagination.total === 1 ? 'artículo' : 'artículos'} · página {pagination.page} de{' '}
              {pagination.pageCount}
            </span>
            <span className="inv-form-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={pagination.page <= 1 || pending}
                onClick={() => go({ page: pagination.page - 1 })}
              >
                Anterior
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={pagination.page >= pagination.pageCount || pending}
                onClick={() => go({ page: pagination.page + 1 })}
              >
                Siguiente
              </Button>
            </span>
          </div>
        </>
      )}

      {capturing ? (
        <StockActionsDialog
          areaKey={areaKey}
          item={{
            zohoItemId: capturing.zohoItemId,
            name: capturing.productName ?? capturing.sku ?? capturing.zohoItemId,
            baseUnit: capturing.baseUnit,
          }}
          defaultWarehouseId={warehouse || null}
          onClose={() => setCapturing(null)}
          onDone={() => startTransition(() => router.refresh())}
        />
      ) : null}
    </div>
  );
}
