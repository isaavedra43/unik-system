'use client';

import React, { useMemo } from 'react';
import { CopilotPanel, type CopilotSurfaceConfig } from '@/components/copilot/CopilotPanel';
import { AREA_LABELS, type AreaKey } from '@/modules/operations/types';
import {
  AREA_COPILOT_MIN_AUTO_INTERVAL_MS,
  AREA_DRAFT_TOOL,
  OPERATIONS_COPILOT_ENDPOINTS,
  areaCopilotStarters,
} from './copilot-starters';

interface Props {
  areaKey: AreaKey;
  user: { id: string; name: string };
  /** ISO time of the latest activity of the visible rows (drives the "inbound" re-analysis). */
  activityAt: string | null;
  /** Visible table (area, query, total, selected ids, first rows): sent as data on every turn. */
  context?: () => Record<string, unknown>;
  /** Overrides the starters of the area (e.g. a special view). */
  starters?: readonly string[];
  onInsertDraft?: (text: string) => void;
  onAfterTurn?: () => void;
  onBack?: () => void;
}

/** Area work-center surface of the shared copilot ("IA supervisando la tabla"). */
export function AreaCopilotPanel({ areaKey, user, activityAt, context, starters, onInsertDraft, onAfterTurn, onBack }: Props) {
  const label = AREA_LABELS[areaKey];
  const surface = useMemo<CopilotSurfaceConfig>(
    () => ({
      surfaceId: areaKey,
      preferenceKey: 'surfaceModes.area',
      endpoints: {
        thread: OPERATIONS_COPILOT_ENDPOINTS.area(areaKey),
        proposal: OPERATIONS_COPILOT_ENDPOINTS.proposal,
      },
      activityAt,
      draftTool: AREA_DRAFT_TOOL,
      starters: starters ? [...starters] : areaCopilotStarters(areaKey),
      minAutoIntervalMs: AREA_COPILOT_MIN_AUTO_INTERVAL_MS,
      copy: {
        eventOpen: `Revisé el trabajo de ${label} al abrirlo`,
        eventInbound: 'Hubo movimiento en el área · reanalicé',
        statusActive: `Atento al trabajo de ${label}`,
        emptyOnDemand: `Estoy aquí. Pregúntame qué está atrasado en ${label}, qué atender primero o pídeme preparar una acción.`,
        emptyPaused: `El copiloto de ${label} está apagado. No analizaré la tabla hasta que lo actives.`,
      },
    }),
    [areaKey, label, activityAt, starters]
  );

  return (
    <CopilotPanel
      surface={surface}
      user={user}
      context={context}
      onInsertDraft={onInsertDraft}
      onAfterTurn={onAfterTurn}
      onBack={onBack}
    />
  );
}
