'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Phone, RefreshCw } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import type { IssuedToken } from '@/modules/voice/livekit-service';
import { PageHeader } from '@/components/ui/composite';
import { Button, Select } from '@/components/ui/primitives';
import { CallsList } from './CallsList';
import { CallDetail } from './CallDetail';
import { NewCallDialog } from './NewCallDialog';

export interface CallsPageClientProps {
  user: CurrentUser;
  canUse: boolean;
  canSupervise: boolean;
}

type StatusFilter = 'all' | 'live' | 'ended';

export function CallsPageClient({ user, canUse, canSupervise }: CallsPageClientProps) {
  const [calls, setCalls] = useState<VoiceCallDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialToken, setInitialToken] = useState<IssuedToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const query =
      filter === 'live'
        ? '?status=ringing,active'
        : filter === 'ended'
          ? '?status=ended,missed,failed'
          : '';
    try {
      const res = await fetch(`/app/calls/api/calls${query}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'No se pudieron cargar las llamadas');
        return;
      }
      const data = (await res.json()) as { calls: VoiceCallDTO[] };
      setCalls(data.calls);
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const onChanged = useCallback((call: VoiceCallDTO) => {
    setCalls((prev) => {
      const idx = prev.findIndex((c) => c.id === call.id);
      if (idx < 0) return [call, ...prev];
      const next = [...prev];
      next[idx] = call;
      return next;
    });
  }, []);

  return (
    <div>
      <PageHeader
        title="Llamadas"
        description={
          canSupervise
            ? 'Llamadas de tus equipos: escucha, lee transcripciones e interviene. Los controles de IA y grabación son independientes y visibles.'
            : 'Tus llamadas internas y externas con copiloto de IA, pausa y grabación con controles visibles.'
        }
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value as StatusFilter)}
              aria-label="Filtrar por estado"
            >
              <option value="all">Todas</option>
              <option value="live">En curso</option>
              <option value="ended">Finalizadas</option>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              onClick={load}
              icon={<RefreshCw size={14} />}
              aria-label="Actualizar lista"
            >
              Actualizar
            </Button>
            {canUse ? (
              <Button size="sm" onClick={() => setDialogOpen(true)} icon={<Phone size={14} />}>
                Nueva llamada
              </Button>
            ) : null}
          </div>
        }
      />

      <div
        style={{
          display: 'grid',
          // Stacks on narrow screens; two columns from ~700px. Never overflows horizontally.
          gridTemplateColumns: selectedId
            ? 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))'
            : '1fr',
          gap: '1rem',
        }}
      >
        <div>
          <CallsList
            calls={calls}
            selectedId={selectedId}
            onSelect={(id) => {
              setInitialToken(null);
              setSelectedId(id);
            }}
            loading={loading}
            error={error}
          />
        </div>
        {selectedId ? (
          <div>
            <CallDetail
              user={user}
              callId={selectedId}
              canUse={canUse}
              canSupervise={canSupervise}
              initialToken={initialToken}
              onChanged={onChanged}
            />
          </div>
        ) : null}
      </div>

      <NewCallDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(call, token) => {
          onChanged(call);
          setInitialToken(token);
          setSelectedId(call.id);
        }}
      />
    </div>
  );
}
