'use client';

import { useEffect, useState } from 'react';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { getAreaClient, type AreaSpecialViewProps } from './area-client-registry';
import { ensureAreaClientRegistrations } from './register-all-client';

export interface AreaSpecialSpaceProps extends AreaSpecialViewProps {
  /** Label of the specialized space, for the placeholder copy. */
  label: string;
  areaLabel: string;
  description: string;
}

type LoadState = 'loading' | 'ready' | 'missing' | 'failed';

/**
 * Specialized space of an area (plan 7.6): Radar de cierre, Laboratorio de
 * sourcing, Mapa de ubicaciones, Tablero de producción, Despacho o Libro de
 * caja. The view itself belongs to the area, so it is loaded on demand from
 * `src/components/areas/<area>/register-client.tsx`.
 *
 * While an area has not written its view, the space explains what will live
 * there instead of failing — the other three spaces of the area work anyway.
 */
export function AreaSpecialView(props: AreaSpecialSpaceProps) {
  const { areaKey, label, areaLabel, description, ...viewProps } = props;
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    ensureAreaClientRegistrations(areaKey)
      .then((registered) => {
        if (cancelled) return;
        const areaModule = getAreaClient(areaKey);
        setState(registered && areaModule.SpecialView ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [areaKey]);

  if (state === 'loading') {
    return <LoadingState variant="list" rows={4} label={`Cargando ${label.toLowerCase()}…`} />;
  }

  if (state === 'failed') {
    return (
      <ErrorState
        title={`No pudimos abrir ${label}`}
        message="Recarga la página; si el problema sigue, avisa a Administración."
      />
    );
  }

  if (state === 'missing') {
    return (
      <div className="area-empty">
        <strong>{label}</strong>
        <p>{description}</p>
        <p>
          Esta vista de {areaLabel} todavía no está disponible. Mientras tanto, el panel, el centro
          de trabajo y las comunicaciones del área funcionan con normalidad.
        </p>
      </div>
    );
  }

  const View = getAreaClient(areaKey).SpecialView;
  if (!View) return null;
  return <View areaKey={areaKey} {...viewProps} />;
}
