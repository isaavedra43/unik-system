'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Phone, PhoneCall, Search } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import type { IssuedToken } from '@/modules/voice/livekit-service';
import { PageHeader } from '@/components/ui/composite';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useCallDock } from './CallDockProvider';
import { CallsLiveStrip, type LiveQuickAction } from './CallsLiveStrip';
import { CallsList, type TypeFilter } from './CallsList';
import { CallDetail } from './CallDetail';
import { NewCallDialog } from './NewCallDialog';
import {
  aiHandled,
  callTitle,
  externalNumberOf,
  formatDuration,
  isLiveCall,
  isSameLocalDay,
  matchesHistoryFilter,
  matchesQuery,
  type HistoryFilter,
} from './calls-format';

export interface CallsPageClientProps {
  user: CurrentUser;
  canUse: boolean;
  canSupervise: boolean;
}

const QUICK_ACTIONS: Record<LiveQuickAction, { path: string; body?: unknown }> = {
  answer: { path: '/token' },
  listen: { path: '/supervise', body: { mode: 'listen' } },
  pauseAi: { path: '/ai/pause' },
  resumeAi: { path: '/ai/resume' },
};

async function fetchCalls(status: string, limit: number): Promise<VoiceCallDTO[]> {
  const res = await fetch(`/app/calls/api/calls?status=${status}&limit=${limit}`);
  const data = (await res.json().catch(() => ({}))) as { calls?: VoiceCallDTO[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'No se pudieron cargar las llamadas');
  return data.calls ?? [];
}

function replaceOrPrepend(list: VoiceCallDTO[], call: VoiceCallDTO): VoiceCallDTO[] {
  return list.some((c) => c.id === call.id)
    ? list.map((c) => (c.id === call.id ? call : c))
    : [call, ...list];
}

export function CallsPageClient({ user, canUse, canSupervise }: CallsPageClientProps) {
  const searchParams = useSearchParams();
  const dock = useCallDock();
  const [live, setLive] = useState<VoiceCallDTO[]>([]);
  const [history, setHistory] = useState<VoiceCallDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('call'));
  const [detailOpen, setDetailOpen] = useState(() => Boolean(searchParams.get('call')));
  const [initialToken, setInitialToken] = useState<IssuedToken | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [type, setType] = useState<TypeFilter>('all');
  const [agent, setAgent] = useState('all');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadLive = useCallback(async () => {
    try {
      setLive(await fetchCalls('ringing,active', 50));
    } catch {
      // The history request reports connectivity problems; keep the last live list.
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await fetchCalls('ended,missed,failed', 150));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLive();
    void loadHistory();
    const liveInterval = window.setInterval(loadLive, 5_000);
    const historyInterval = window.setInterval(loadHistory, 30_000);
    return () => {
      window.clearInterval(liveInterval);
      window.clearInterval(historyInterval);
    };
  }, [loadLive, loadHistory]);

  const upsert = useCallback((call: VoiceCallDTO) => {
    const liveNow = isLiveCall(call);
    setLive((prev) =>
      liveNow ? replaceOrPrepend(prev, call) : prev.filter((c) => c.id !== call.id)
    );
    setHistory((prev) =>
      liveNow ? prev.filter((c) => c.id !== call.id) : replaceOrPrepend(prev, call)
    );
  }, []);

  const select = useCallback((id: string, token: IssuedToken | null = null) => {
    setInitialToken(token);
    setSelectedId(id);
    setDetailOpen(true);
  }, []);

  const quick = useCallback(
    async (call: VoiceCallDTO, action: LiveQuickAction) => {
      const { path, body } = QUICK_ACTIONS[action];
      setBusyKey(`${call.id}:${action}`);
      setActionError(null);
      try {
        const res = await fetch(`/app/calls/api/calls/${call.id}${path}`, {
          method: 'POST',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = (await res.json().catch(() => ({}))) as {
          call?: VoiceCallDTO;
          token?: IssuedToken;
          error?: string;
        };
        if (!res.ok) {
          setActionError(data.error ?? 'No se pudo completar la acción');
          return;
        }
        if (data.call) upsert(data.call);
        if (data.token) select(call.id, data.token);
        void loadLive();
      } catch {
        setActionError('Error de red: revisa tu conexión e inténtalo de nuevo.');
      } finally {
        setBusyKey(null);
      }
    },
    [loadLive, select, upsert]
  );

  const callback = useMemo(() => {
    if (!canUse || !dock.enabled) return undefined;
    return (call: VoiceCallDTO) => {
      const toNumber = externalNumberOf(call);
      if (!toNumber) return;
      void dock.dial({
        toNumber,
        contactId: call.contactId,
        accountId: call.accountId,
        label: callTitle(call, user.id),
      });
    };
  }, [canUse, dock, user.id]);

  const agents = useMemo(() => {
    const names = new Map<string, string>();
    for (const call of history) {
      for (const p of call.participants) {
        if (p.userId && p.userName && p.role !== 'supervisor') names.set(p.userId, p.userName);
      }
    }
    return [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [history]);

  const baseRows = useMemo(
    () =>
      history.filter(
        (c) =>
          (type === 'all' || c.type === type) &&
          (agent === 'all' ||
            c.participants.some((p) => p.userId === agent && p.role !== 'supervisor')) &&
          matchesQuery(c, query, user.id)
      ),
    [history, type, agent, query, user.id]
  );

  const counts = useMemo<Record<HistoryFilter, number>>(
    () => ({
      all: baseRows.length,
      missed: baseRows.filter((c) => matchesHistoryFilter(c, 'missed')).length,
      ai: baseRows.filter((c) => matchesHistoryFilter(c, 'ai')).length,
      recorded: baseRows.filter((c) => matchesHistoryFilter(c, 'recorded')).length,
    }),
    [baseRows]
  );

  const rows = useMemo(
    () => baseRows.filter((c) => matchesHistoryFilter(c, filter)),
    [baseRows, filter]
  );
  const hasActiveFilters =
    filter !== 'all' || type !== 'all' || agent !== 'all' || query.trim() !== '';

  const today = useMemo(() => {
    const now = new Date();
    const all = [...live, ...history].filter((c) => isSameLocalDay(new Date(c.createdAt), now));
    const finished = all.filter((c) => c.status === 'ended' && typeof c.durationSec === 'number');
    return {
      total: all.length,
      missed: all.filter((c) => c.status === 'missed').length,
      avg: finished.length
        ? Math.round(finished.reduce((sum, c) => sum + (c.durationSec ?? 0), 0) / finished.length)
        : null,
      ai: all.filter(aiHandled).length,
      recorded: all.filter((c) => Boolean(c.recordingObjectId)).length,
    };
  }, [live, history]);

  const clearFilters = useCallback(() => {
    setFilter('all');
    setType('all');
    setAgent('all');
    setQuery('');
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        if (event.key === 'Escape' && target === searchRef.current) target.blur();
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if ((event.key === 'n' || event.key === 'N') && canUse) {
        event.preventDefault();
        setDialogOpen(true);
      } else if (event.key === 'j' || event.key === 'k') {
        const ids = [...live, ...rows].map((c) => c.id);
        if (ids.length === 0) return;
        event.preventDefault();
        const index = selectedId ? ids.indexOf(selectedId) : -1;
        const next =
          event.key === 'j' ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1);
        select(ids[next]);
        window.requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[data-call-id="${ids[next]}"]`)?.focus()
        );
      } else if (event.key === 'Escape') {
        setDetailOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canUse, live, rows, select, selectedId]);

  const showToday = !loading || history.length > 0 || live.length > 0;

  return (
    <div className="calls-page">
      <PageHeader
        title="Llamadas"
        description={
          canSupervise
            ? 'Atiende, supervisa y revisa las llamadas de tus equipos.'
            : 'Tus llamadas, con copiloto de IA y grabación bajo tu control.'
        }
        actions={
          <div className="calls-header-actions">
            <label className="calls-search">
              <span className="sr-only">Buscar llamadas</span>
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                className="input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Contacto, número, agente o tema"
                autoComplete="off"
                aria-keyshortcuts="/"
              />
              {query ? null : (
                <kbd className="calls-kbd" aria-hidden="true">
                  /
                </kbd>
              )}
            </label>
            {canUse ? (
              <Button
                onClick={() => setDialogOpen(true)}
                icon={<Phone size={15} />}
                aria-keyshortcuts="N"
              >
                Nueva llamada
              </Button>
            ) : null}
          </div>
        }
      />

      {actionError ? (
        <div className="alert alert-error calls-alert" role="alert">
          <span>{actionError}</span>
          <button type="button" className="calls-link" onClick={() => setActionError(null)}>
            Cerrar
          </button>
        </div>
      ) : null}

      {showToday ? (
        <div className="calls-today" role="group" aria-label="Resumen de hoy">
          <span className="calls-today-label">
            {canSupervise ? 'Hoy · tus equipos' : 'Hoy · tus llamadas'}
          </span>
          <span className="calls-stat">
            <b>{today.total}</b> {today.total === 1 ? 'llamada' : 'llamadas'}
          </span>
          <button
            type="button"
            className={cn('calls-stat', today.missed > 0 && 'is-alert')}
            onClick={() => setFilter('missed')}
            disabled={today.missed === 0}
            title={today.missed > 0 ? 'Ver llamadas perdidas' : undefined}
          >
            <b>{today.missed}</b> {today.missed === 1 ? 'perdida' : 'perdidas'}
          </button>
          <span className="calls-stat">
            <b className="calls-mono">{formatDuration(today.avg)}</b> duración media
          </span>
          <span className="calls-stat">
            <b>{today.ai}</b> con asistente de voz
          </span>
          <span className="calls-stat">
            <b>{today.recorded}</b> con grabación
          </span>
        </div>
      ) : null}

      <CallsLiveStrip
        calls={live}
        loading={loading}
        userId={user.id}
        canUse={canUse}
        canSupervise={canSupervise}
        selectedId={selectedId}
        busyKey={busyKey}
        onSelect={(id) => select(id)}
        onQuick={quick}
      />

      <div className="calls-workspace">
        <CallsList
          calls={rows}
          total={history.length}
          counts={counts}
          filter={filter}
          onFilterChange={setFilter}
          type={type}
          onTypeChange={setType}
          agent={agent}
          onAgentChange={setAgent}
          agents={agents}
          showAgentFilter={canSupervise && agents.length > 1}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={clearFilters}
          selectedId={selectedId}
          onSelect={(id) => select(id)}
          userId={user.id}
          loading={loading}
          error={error}
          onRetry={() => {
            setLoading(true);
            void loadHistory();
          }}
          onCallback={callback}
          canCall={canUse}
          onNewCall={() => setDialogOpen(true)}
        />

        <aside
          className={cn('calls-detail', detailOpen && 'is-open', !selectedId && 'is-empty')}
          aria-label="Detalle de la llamada"
        >
          {selectedId ? (
            <CallDetail
              user={user}
              callId={selectedId}
              canUse={canUse}
              canSupervise={canSupervise}
              initialToken={initialToken}
              onChanged={upsert}
              onClose={() => setDetailOpen(false)}
              onCallback={callback}
            />
          ) : (
            <DetailPlaceholder canUse={canUse} />
          )}
        </aside>
        {selectedId && detailOpen ? (
          <button
            type="button"
            className="calls-detail-scrim"
            aria-label="Cerrar detalle"
            tabIndex={-1}
            onClick={() => setDetailOpen(false)}
          />
        ) : null}
      </div>

      <NewCallDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(call, token) => {
          upsert(call);
          select(call.id, token);
        }}
      />
    </div>
  );
}

function DetailPlaceholder({ canUse }: { canUse: boolean }) {
  return (
    <div className="calls-detail-empty">
      <span className="calls-empty-icon" aria-hidden="true">
        <PhoneCall size={18} />
      </span>
      <h3>Selecciona una llamada</h3>
      <p>
        Verás el resumen, la transcripción, la grabación y, si sigue en curso, los controles de IA,
        grabación y supervisión.
      </p>
      <dl className="calls-keys">
        <dt>
          <kbd className="calls-kbd">J</kbd>
          <kbd className="calls-kbd">K</kbd>
        </dt>
        <dd>Siguiente y anterior</dd>
        <dt>
          <kbd className="calls-kbd">/</kbd>
        </dt>
        <dd>Buscar</dd>
        {canUse ? (
          <>
            <dt>
              <kbd className="calls-kbd">N</kbd>
            </dt>
            <dd>Nueva llamada</dd>
          </>
        ) : null}
        <dt>
          <kbd className="calls-kbd">Esc</kbd>
        </dt>
        <dd>Cerrar el detalle</dd>
      </dl>
    </div>
  );
}
