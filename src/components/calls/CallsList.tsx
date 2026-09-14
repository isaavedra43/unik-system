'use client';

import React from 'react';
import {
  AudioLines,
  MessageSquareText,
  PhoneCall,
  PhoneOutgoing,
  RefreshCw,
  SearchX,
} from 'lucide-react';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import { Button, IconButton, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { CallDirectionIcon } from './CallBadges';
import {
  aiHandled,
  callSubtitle,
  callTitle,
  dayKey,
  dayLabel,
  externalNumberOf,
  formatDuration,
  handlerLabel,
  summarySnippet,
  timeLabel,
  type HistoryFilter,
} from './calls-format';

export type TypeFilter = 'all' | VoiceCallDTO['type'];

const FILTERS: Array<{ key: HistoryFilter; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'missed', label: 'Perdidas' },
  { key: 'ai', label: 'IA atendió' },
  { key: 'recorded', label: 'Con grabación' },
];

export interface CallsListProps {
  calls: VoiceCallDTO[];
  total: number;
  counts: Record<HistoryFilter, number>;
  filter: HistoryFilter;
  onFilterChange: (filter: HistoryFilter) => void;
  type: TypeFilter;
  onTypeChange: (type: TypeFilter) => void;
  agent: string;
  onAgentChange: (agent: string) => void;
  agents: Array<{ id: string; name: string }>;
  showAgentFilter: boolean;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  userId: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCallback?: (call: VoiceCallDTO) => void;
  canCall: boolean;
  onNewCall: () => void;
}

export function CallsList(props: CallsListProps) {
  const {
    calls,
    total,
    counts,
    filter,
    onFilterChange,
    type,
    onTypeChange,
    agent,
    onAgentChange,
    agents,
    showAgentFilter,
    hasActiveFilters,
    onClearFilters,
    loading,
    error,
    onRetry,
    canCall,
    onNewCall,
  } = props;

  return (
    <section className="calls-panel" aria-label="Historial de llamadas">
      <div className="calls-toolbar">
        <div className="calls-seg" role="group" aria-label="Filtrar historial">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => onFilterChange(f.key)}
            >
              {f.label}
              <span className="calls-seg-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="calls-toolbar-selects">
          <Select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as TypeFilter)}
            aria-label="Tipo de llamada"
          >
            <option value="all">Todos los tipos</option>
            <option value="inbound">Entrantes</option>
            <option value="outbound">Salientes</option>
            <option value="internal">Internas</option>
          </Select>
          {showAgentFilter ? (
            <Select
              value={agent}
              onChange={(e) => onAgentChange(e.target.value)}
              aria-label="Agente"
            >
              <option value="all">Todo el equipo</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      </div>

      {loading && total === 0 ? (
        <div className="calls-skeleton" aria-busy="true" aria-label="Cargando llamadas">
          {[72, 58, 66, 50, 62].map((w, i) => (
            <div key={i} className="calls-skeleton-row">
              <span className="calls-skel is-circle" />
              <span className="calls-skel-lines">
                <span className="calls-skel" style={{ width: `${w}%` }} />
                <span className="calls-skel is-thin" style={{ width: `${w - 22}%` }} />
              </span>
              <span className="calls-skel" />
            </div>
          ))}
        </div>
      ) : error && total === 0 ? (
        <div className="calls-empty">
          <span className="calls-empty-icon" aria-hidden="true">
            <RefreshCw size={18} />
          </span>
          <h3>No se pudieron cargar las llamadas</h3>
          <p>{error}</p>
          <Button variant="secondary" size="sm" onClick={onRetry} icon={<RefreshCw size={14} />}>
            Reintentar
          </Button>
        </div>
      ) : total === 0 ? (
        <div className="calls-empty">
          <span className="calls-empty-icon" aria-hidden="true">
            <PhoneCall size={18} />
          </span>
          <h3>Aún no hay llamadas</h3>
          <p>
            Cuando alguien llame a tus líneas o hagas una llamada, aquí verás quién llamó, quién
            atendió, el resumen y la grabación.
          </p>
          {canCall ? (
            <Button size="sm" onClick={onNewCall} icon={<PhoneOutgoing size={14} />}>
              Hacer una llamada
            </Button>
          ) : null}
        </div>
      ) : calls.length === 0 ? (
        <div className="calls-empty">
          <span className="calls-empty-icon" aria-hidden="true">
            <SearchX size={18} />
          </span>
          <h3>Ninguna llamada coincide</h3>
          <p>Prueba con otro nombre o número, o quita los filtros.</p>
          <Button variant="secondary" size="sm" onClick={onClearFilters}>
            Quitar filtros
          </Button>
        </div>
      ) : (
        <CallGroups {...props} />
      )}

      {total > 0 ? (
        <footer className="calls-list-foot">
          <span className="calls-foot-count">
            {hasActiveFilters
              ? `${calls.length} de ${total} llamadas`
              : `${total} ${total === 1 ? 'llamada reciente' : 'llamadas recientes'}`}
            {error ? ' · sin actualizar' : ''}
          </span>
          <span className="calls-foot-keys">
            <kbd className="calls-kbd">J</kbd>
            <kbd className="calls-kbd">K</kbd> moverse
          </span>
          <span className="calls-foot-keys">
            <kbd className="calls-kbd">/</kbd> buscar
          </span>
          {canCall ? (
            <span className="calls-foot-keys">
              <kbd className="calls-kbd">N</kbd> nueva llamada
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

function CallGroups({ calls, selectedId, onSelect, userId, onCallback }: CallsListProps) {
  const groups: Array<{ key: string; label: string; calls: VoiceCallDTO[] }> = [];
  for (const call of calls) {
    const key = dayKey(call.createdAt);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(call.createdAt), calls: [] };
      groups.push(group);
    }
    group.calls.push(call);
  }

  return (
    <div>
      <div className="calls-cols" aria-hidden="true">
        <span />
        <span>Llamada</span>
        <span>Atendió</span>
        <span />
        <span className="is-right">Hora</span>
        <span className="is-right">Dur.</span>
      </div>
      {groups.map((group) => (
        <div key={group.key} role="group" aria-label={group.label}>
          <div className="calls-day">
            {group.label}
            <span>
              {group.calls.length} {group.calls.length === 1 ? 'llamada' : 'llamadas'}
            </span>
          </div>
          <ul className="calls-rows">
            {group.calls.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                selected={selectedId === call.id}
                onSelect={onSelect}
                userId={userId}
                onCallback={onCallback}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CallRow({
  call,
  selected,
  onSelect,
  userId,
  onCallback,
}: {
  call: VoiceCallDTO;
  selected: boolean;
  onSelect: (id: string) => void;
  userId: string;
  onCallback?: (call: VoiceCallDTO) => void;
}) {
  const title = callTitle(call, userId);
  const snippet =
    call.status === 'missed'
      ? 'Sin respuesta'
      : call.status === 'failed'
        ? 'No se pudo conectar'
        : summarySnippet(call.summary);
  const canCallBack = Boolean(onCallback && externalNumberOf(call));

  return (
    <li className={cn('calls-row', selected && 'is-selected', canCallBack && 'has-actions')}>
      <button
        type="button"
        className="calls-row-main"
        data-call-id={call.id}
        onClick={() => onSelect(call.id)}
        aria-current={selected || undefined}
      >
        <CallDirectionIcon call={call} />
        <span className="calls-who">
          <strong title={title}>{title}</strong>
          <small>
            <span className={call.contactName ? 'calls-mono' : undefined}>
              {callSubtitle(call)}
            </span>
            {snippet ? (
              <span
                className={
                  call.status === 'missed' || call.status === 'failed'
                    ? 'calls-text-danger'
                    : undefined
                }
              >
                {' · '}
                {snippet}
              </span>
            ) : null}
          </small>
        </span>
        <span className="calls-handler">{handlerLabel(call, userId)}</span>
        <RowMarks call={call} />
        <span className="calls-time">{timeLabel(call.createdAt)}</span>
        <span className="calls-dur">{formatDuration(call.durationSec)}</span>
      </button>
      {canCallBack ? (
        <span className="calls-row-actions">
          <IconButton
            onClick={() => onCallback?.(call)}
            aria-label={`Devolver llamada a ${title}`}
            title="Devolver llamada"
          >
            <PhoneOutgoing size={15} />
          </IconButton>
        </span>
      ) : null}
    </li>
  );
}

function RowMarks({ call }: { call: VoiceCallDTO }) {
  if (call.status === 'missed') {
    return (
      <span className="calls-marks">
        <span className="badge badge-danger">Perdida</span>
      </span>
    );
  }
  if (call.status === 'failed') {
    return (
      <span className="calls-marks">
        <span className="badge badge-danger">Falló</span>
      </span>
    );
  }
  return (
    <span className="calls-marks">
      {aiHandled(call) ? (
        <span className="badge badge-info">IA atendió</span>
      ) : call.aiState === 'paused' ? (
        <span className="badge badge-warning">IA en pausa</span>
      ) : null}
      {call.segmentCount > 0 ? (
        <span className="calls-mark" title={`${call.segmentCount} frases transcritas`}>
          <MessageSquareText size={15} aria-hidden="true" />
          <span className="sr-only">Con transcripción</span>
        </span>
      ) : null}
      {call.recordingObjectId ? (
        <span className="calls-mark" title="Con grabación">
          <AudioLines size={15} aria-hidden="true" />
          <span className="sr-only">Con grabación</span>
        </span>
      ) : null}
    </span>
  );
}
