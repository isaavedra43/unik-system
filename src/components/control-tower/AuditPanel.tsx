'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Search } from 'lucide-react';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { operationsCaseHref } from '@/components/operations/copilot-starters';
import { Alert, Badge, Button, Input, Select } from '@/components/ui/primitives';
import { relativeSince } from '@/modules/areas/area-time';
import {
  AUDIT_TARGET_GROUPS,
  EMPTY_AUDIT_FILTERS,
  auditQueryString,
  auditTargetLabel,
  hasAuditFilters,
  humanizeAuditAction,
  summarizeAuditMetadata,
  type AuditFilterState,
} from './audit-model';

/**
 * Operations audit (plan 7.7 `auditoría`): who did what, on which object and
 * when, filtered to the objects of the operation.
 *
 * Read-only by definition. The metadata of an entry is summarized (key: value)
 * instead of dumped as raw JSON, and it is shown as DATA: an audit entry may
 * carry text a person wrote, and this screen never treats it as an instruction.
 */

export interface AuditRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorIsBot: boolean;
}

export interface AuditPage {
  data: AuditRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface AuditPanelProps {
  initial: AuditPage;
  initialFilters: AuditFilterState;
  /** People who appear in the audit, for the actor picker. */
  actors: Array<{ id: string; name: string }>;
  nowIso: string;
}

const PAGE_SIZE = 50;

export function AuditPanel({ initial, initialFilters, actors, nowIso }: AuditPanelProps) {
  const [page, setPage] = useState<AuditPage>(initial);
  const [filters, setFilters] = useState<AuditFilterState>(initialFilters);
  const [applied, setApplied] = useState<AuditFilterState>(initialFilters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useMemo(() => Date.parse(nowIso) || Date.now(), [nowIso]);

  useEffect(() => {
    setPage(initial);
  }, [initial]);

  const load = useCallback(async (next: AuditFilterState, pageNumber: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/app/admin/control-tower/api/audit?${auditQueryString(next, pageNumber, PAGE_SIZE)}`
      );
      const data = (await response.json().catch(() => ({}))) as AuditPage & { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'No pudimos cargar la auditoría');
        return;
      }
      setPage(data);
      setApplied(next);
    } catch {
      setError('No pudimos cargar la auditoría; revisa tu conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  const pagination = page.pagination;

  return (
    <div className="ct-table-card">
      <form
        className="ct-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load(filters, 1);
        }}
      >
        <div className="ct-filter ct-filter-grow">
          <label htmlFor="ct-audit-action">Acción</label>
          <Input
            id="ct-audit-action"
            value={filters.action}
            placeholder="p. ej. workitem.reassign"
            maxLength={80}
            leftIcon={<Search size={14} />}
            onChange={(event) =>
              setFilters((current) => ({ ...current, action: event.target.value }))
            }
          />
        </div>
        <div className="ct-filter">
          <label htmlFor="ct-audit-target">Objeto</label>
          <Select
            id="ct-audit-target"
            value={filters.targetType}
            onChange={(event) =>
              setFilters((current) => ({ ...current, targetType: event.target.value }))
            }
          >
            <option value="">Todos</option>
            {/* Agrupado: son decenas de tipos y en una lista plana no se encuentran. */}
            {AUDIT_TARGET_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {auditTargetLabel(type)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        <div className="ct-filter">
          <label htmlFor="ct-audit-actor">Persona</label>
          <Select
            id="ct-audit-actor"
            value={filters.actorUserId}
            onChange={(event) =>
              setFilters((current) => ({ ...current, actorUserId: event.target.value }))
            }
          >
            <option value="">Todas</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="ct-filter">
          <label htmlFor="ct-audit-from">Desde</label>
          <Input
            id="ct-audit-from"
            type="date"
            value={filters.from}
            onChange={(event) =>
              setFilters((current) => ({ ...current, from: event.target.value }))
            }
          />
        </div>
        <div className="ct-filter">
          <label htmlFor="ct-audit-to">Hasta</label>
          <Input
            id="ct-audit-to"
            type="date"
            value={filters.to}
            onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
        <div className="ct-actions">
          <Button type="submit" size="sm" disabled={loading}>
            {loading ? 'Buscando…' : 'Buscar'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => {
              setFilters(EMPTY_AUDIT_FILTERS);
              void load(EMPTY_AUDIT_FILTERS, 1);
            }}
          >
            Limpiar
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void load(applied, pagination.page)}
            aria-label="Volver a cargar la auditoría"
          >
            <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
            Actualizar
          </Button>
        </div>
      </form>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <ChartCard
        title="Movimientos de la operación"
        description={`${pagination.total.toLocaleString('es-MX')} registros${
          hasAuditFilters(applied) ? ' con los filtros aplicados' : ''
        }.`}
        height="auto"
        state={loading && page.data.length === 0 ? 'loading' : undefined}
      >
        {page.data.length === 0 && !loading ? (
          <div className="ct-empty">
            <strong>Sin movimientos</strong>
            <p>
              {hasAuditFilters(applied)
                ? 'Ningún registro coincide con estos filtros. Prueba con un rango de fechas más amplio.'
                : 'Todavía no hay movimientos auditados de la operación.'}
            </p>
          </div>
        ) : (
          <div className="ct-table-scroll">
            <table className="table">
              <caption className="sr-only">Auditoría de los objetos de la operación</caption>
              <thead>
                <tr>
                  <th scope="col">Cuándo</th>
                  <th scope="col">Quién</th>
                  <th scope="col">Acción</th>
                  <th scope="col">Objeto</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {page.data.map((row) => {
                  const summary = summarizeAuditMetadata(row.metadata);
                  const caseHref =
                    row.targetType === 'operational_case' ? operationsCaseHref(row.targetId) : null;
                  return (
                    <tr key={row.id}>
                      <td className="ct-numeric" title={row.createdAt}>
                        {relativeSince(row.createdAt, now)}
                      </td>
                      <td>
                        {row.actorName ?? <span className="text-muted">Sistema</span>}
                        {row.actorIsBot ? (
                          <span className="ct-cell-sub">
                            <Badge variant="info">IA</Badge>
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="ct-cell-strong">{humanizeAuditAction(row.action)}</span>
                        <span className="ct-cell-sub">{row.action}</span>
                      </td>
                      <td>
                        {auditTargetLabel(row.targetType)}
                        <span className="ct-cell-sub">
                          {caseHref ? <Link href={caseHref}>{row.targetId}</Link> : row.targetId}
                        </span>
                      </td>
                      <td>{summary ?? <span className="text-muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="ct-pagination">
          <span>
            Página {pagination.page} de {pagination.total_pages}
          </span>
          <span className="ct-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={loading || pagination.page <= 1}
              onClick={() => void load(applied, pagination.page - 1)}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={loading || pagination.page >= pagination.total_pages}
              onClick={() => void load(applied, pagination.page + 1)}
            >
              Siguiente
            </Button>
          </span>
        </div>
      </ChartCard>
    </div>
  );
}
