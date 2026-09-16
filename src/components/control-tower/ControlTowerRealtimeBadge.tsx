'use client';

import { useEffect, useState } from 'react';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { AREA_WORK_REALTIME_TYPES } from '@/modules/areas/area-work-row';
import { CONTROL_TOWER_AREA_CHANNELS } from './control-tower-views';

/**
 * Live chip of the whole operation: the six area channels over the shared SSE
 * stream. The server drops any channel this person may not read (the rule is
 * `operations.view` or membership of the area channel), so the chip simply
 * stays idle instead of failing.
 *
 * It never changes the numbers on screen: it only says whether the company is
 * moving right now, so an idle Control Tower is not mistaken for a stale page.
 */
function elapsedLabel(from: number, now: number): string {
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

export interface ControlTowerRealtimeBadgeProps {
  /** Notified on every operational event, so a view can offer "Actualizar". */
  onEvent?: () => void;
}

export function ControlTowerRealtimeBadge({ onEvent }: ControlTowerRealtimeBadgeProps) {
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useOperationsRealtime(CONTROL_TOWER_AREA_CHANNELS, AREA_WORK_REALTIME_TYPES, () => {
    setLastEventAt(Date.now());
    onEvent?.();
  });

  useEffect(() => {
    if (lastEventAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [lastEventAt]);

  const live = lastEventAt !== null;
  return (
    <span
      className={`ct-live ${live ? 'ct-live-pulse' : 'ct-live-idle'}`}
      title={
        live
          ? `Último movimiento de la operación ${elapsedLabel(lastEventAt, now)}`
          : 'Escuchando los movimientos de las seis áreas en tiempo real'
      }
    >
      <span className="ct-live-dot" aria-hidden="true" />
      <span>{live ? `Movimiento ${elapsedLabel(lastEventAt, now)}` : 'En vivo'}</span>
    </span>
  );
}
