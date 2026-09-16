'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { Alert, Badge, Button, Input, Select } from '@/components/ui/primitives';
import { formatDueLabel } from '@/components/operations/mywork-model';
import { relativeSince } from '@/modules/areas/area-time';
import type { PeopleNowResult, PersonNow } from '@/modules/control-tower/people-service';
import {
  EMPTY_PEOPLE_FILTERS,
  PRESENCE_ORDER,
  elapsedLabel,
  filterPeople,
  lastEventLine,
  loadTone,
  peopleAreaOptions,
  presenceTone,
  type PeopleFilterState,
} from './people-model';

/**
 * "Quién está haciendo qué ahora" (plan 7.7 `personas`).
 *
 * The server hands the first page; the area filter and "incluir a quien no
 * tiene trabajo" go back to `GET .../api/people` (they change the query), while
 * presence and the text box filter what is already on screen — so typing never
 * costs a round trip.
 *
 * The last event is the same sentence the case timeline uses
 * (`formatTimelineLine`), so nobody reads two different wordings for one fact.
 */

export interface PeopleNowTableProps {
  initial: PeopleNowResult;
  /** Server time of the render, so the first labels match on hydration. */
  nowIso: string;
}

const PRESENCE_LABELS_BY_KEY: Record<string, string> = {
  active: 'Activo',
  idle: 'Sin movimiento reciente',
  inactive: 'Sin actividad hoy',
  unassigned: 'Sin trabajo asignado',
};

export function PeopleNowTable({ initial, nowIso }: PeopleNowTableProps) {
  const [result, setResult] = useState<PeopleNowResult>(initial);
  const [filters, setFilters] = useState<PeopleFilterState>(EMPTY_PEOPLE_FILTERS);
  const [includeIdle, setIncludeIdle] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useMemo(() => new Date(Date.parse(nowIso) || Date.now()), [nowIso]);

  useEffect(() => {
    setResult(initial);
  }, [initial]);

  const load = useCallback(async (next: { areaKey: string; includeIdle: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (next.areaKey) params.set('areaKey', next.areaKey);
      if (!next.includeIdle) params.set('idle', '0');
      const response = await fetch(`/app/admin/control-tower/api/people?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as PeopleNowResult & {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'No pudimos cargar a las personas');
        return;
      }
      setResult(data);
    } catch {
      setError('No pudimos cargar a las personas; revisa tu conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  const areaOptions = useMemo(() => peopleAreaOptions(result.people), [result.people]);
  const people = useMemo(() => filterPeople(result.people, filters), [result.people, filters]);

  const onAreaChange = (areaKey: string) => {
    setFilters((current) => ({ ...current, areaKey }));
    void load({ areaKey, includeIdle });
  };

  const onIdleChange = (value: boolean) => {
    setIncludeIdle(value);
    void load({ areaKey: filters.areaKey, includeIdle: value });
  };

  return (
    <div className="ct-table-card">
      <KpiGrid columns={4} aria-label="Personas en la operación">
        <StatCard label="Personas" value={result.totals.people.toLocaleString('es-MX')} />
        <StatCard
          label="Activas ahora"
          value={result.totals.active.toLocaleString('es-MX')}
          tone={result.totals.active > 0 ? 'success' : 'default'}
          hint="Con un evento en los últimos 15 minutos"
        />
        <StatCard
          label="Con trabajo vencido"
          value={result.totals.withOverdue.toLocaleString('es-MX')}
          tone={result.totals.withOverdue > 0 ? 'danger' : 'success'}
        />
        <StatCard
          label="Sin asignaciones"
          value={result.totals.unassigned.toLocaleString('es-MX')}
          hint="Pueden tomar trabajo"
        />
      </KpiGrid>

      <div className="ct-filters">
        <div className="ct-filter">
          <label htmlFor="ct-people-area">Área</label>
          <Select
            id="ct-people-area"
            value={filters.areaKey}
            onChange={(event) => onAreaChange(event.target.value)}
            disabled={loading}
          >
            <option value="">Todas</option>
            {areaOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="ct-filter">
          <label htmlFor="ct-people-presence">Estado</label>
          <Select
            id="ct-people-presence"
            value={filters.presence}
            onChange={(event) =>
              setFilters((current) => ({ ...current, presence: event.target.value }))
            }
          >
            <option value="">Cualquiera</option>
            {PRESENCE_ORDER.map((presence) => (
              <option key={presence} value={presence}>
                {PRESENCE_LABELS_BY_KEY[presence]}
              </option>
            ))}
          </Select>
        </div>
        <div className="ct-filter">
          <label htmlFor="ct-people-idle">Incluir</label>
          <Select
            id="ct-people-idle"
            value={includeIdle ? 'all' : 'busy'}
            onChange={(event) => onIdleChange(event.target.value === 'all')}
            disabled={loading}
          >
            <option value="all">A todas las personas</option>
            <option value="busy">Sólo con trabajo abierto</option>
          </Select>
        </div>
        <div className="ct-filter ct-filter-grow">
          <label htmlFor="ct-people-search">Buscar</label>
          <Input
            id="ct-people-search"
            value={filters.search}
            placeholder="Nombre, área o pendiente…"
            onChange={(event) =>
              setFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
        </div>
        <div className="ct-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void load({ areaKey: filters.areaKey, includeIdle }).then(() =>
                toast.success('Personas actualizadas')
              );
            }}
            disabled={loading}
            aria-label="Actualizar la lista de personas"
          >
            <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
            Actualizar
          </Button>
        </div>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <ChartCard
        title="Personas ahora mismo"
        description={`Actualizado ${relativeSince(result.computedAt, now)}.`}
        height="auto"
        state={loading && people.length === 0 ? 'loading' : undefined}
      >
        {people.length === 0 && !loading ? (
          <div className="ct-empty">
            <Users size={24} aria-hidden="true" />
            <strong>Nadie coincide con estos filtros</strong>
            <p>Quita un filtro o amplía el área para ver a más personas.</p>
          </div>
        ) : (
          <div className="ct-table-scroll">
            <table className="table">
              <caption className="sr-only">
                Carga, último movimiento y estado de cada persona
              </caption>
              <thead>
                <tr>
                  <th scope="col">Persona</th>
                  <th scope="col">Área</th>
                  <th scope="col">En curso</th>
                  <th scope="col">Abiertos</th>
                  <th scope="col">Vencidos</th>
                  <th scope="col">Siguiente</th>
                  <th scope="col">Último movimiento</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <PersonRow key={person.userId} person={person} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>
    </div>
  );
}

function PersonRow({ person, now }: { person: PersonNow; now: Date }) {
  const event = lastEventLine(person);
  const due = person.nextDueAt ? formatDueLabel(person.nextDueAt, now) : null;
  return (
    <tr>
      <th scope="row" className="ct-cell-strong">
        {person.name}
        <span className="ct-cell-sub">@{person.username}</span>
      </th>
      <td>
        {person.areaLabel ?? <span className="text-muted">Sin área</span>}
        {person.role ? <span className="ct-cell-sub">{person.role}</span> : null}
      </td>
      <td className="ct-numeric">{person.inProgressWorkItems}</td>
      <td className="ct-numeric">
        {person.openWorkItems > 0 ? (
          <Badge variant={loadTone(person)}>{person.openWorkItems}</Badge>
        ) : (
          <span className="text-muted">0</span>
        )}
      </td>
      <td className="ct-numeric">
        {person.overdueWorkItems > 0 ? (
          <Badge variant="danger">{person.overdueWorkItems}</Badge>
        ) : (
          <span className="text-muted">0</span>
        )}
      </td>
      <td>
        {person.nextTitle ? (
          <>
            <span>{person.nextTitle}</span>
            {due ? (
              <span className="ct-cell-sub" title={due.title}>
                {due.label}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted">Sin pendientes</span>
        )}
      </td>
      <td>
        {event ? (
          <>
            <span>{event}</span>
            <span className="ct-cell-sub">{elapsedLabel(person.lastEventMinutesAgo)}</span>
          </>
        ) : (
          <span className="text-muted">Sin actividad registrada</span>
        )}
      </td>
      <td>
        <Badge variant={presenceTone(person.presence)}>{person.presenceLabel}</Badge>
      </td>
    </tr>
  );
}
