'use client';

import { useEffect, useState } from 'react';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { AREA_WORK_REALTIME_TYPES } from '@/modules/areas/area-work-row';

export interface AreaRealtimeBadgeProps {
  areaKey: string;
  areaLabel: string;
}

function elapsedLabel(from: number, now: number): string {
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/**
 * Live chip of an area (`area:{key}` over the shared SSE stream). It says when
 * the last operational event of the area arrived, so a person can tell a quiet
 * area from a stale page. The server drops the channel when the person may not
 * read it, and then the chip simply stays idle.
 */
export function AreaRealtimeBadge({ areaKey, areaLabel }: AreaRealtimeBadgeProps) {
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useOperationsRealtime([`area:${areaKey}`], AREA_WORK_REALTIME_TYPES, () => {
    setLastEventAt(Date.now());
  });

  useEffect(() => {
    if (lastEventAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [lastEventAt]);

  const live = lastEventAt !== null;
  return (
    <span
      className={`area-live ${live ? 'area-live-pulse' : 'area-live-idle'}`}
      title={
        live
          ? `Último movimiento de ${areaLabel} ${elapsedLabel(lastEventAt, now)}`
          : `Escuchando los movimientos de ${areaLabel} en tiempo real`
      }
    >
      <span className="area-live-dot" aria-hidden="true" />
      <span>{live ? `Movimiento ${elapsedLabel(lastEventAt, now)}` : 'En vivo'}</span>
    </span>
  );
}
