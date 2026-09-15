'use client';

import React, { useMemo } from 'react';
import { CopilotPanel, type CopilotSurfaceConfig } from '@/components/copilot/CopilotPanel';
import {
  AREA_DRAFT_TOOL,
  CONTROL_TOWER_COPILOT_MIN_AUTO_INTERVAL_MS,
  CONTROL_TOWER_STARTERS,
  OPERATIONS_COPILOT_ENDPOINTS,
} from './copilot-starters';

interface Props {
  user: { id: string; name: string };
  /** ISO time of the latest operational event of the company. */
  activityAt: string | null;
  /** The view on screen (e.g. resumen, excepciones and its filters): sent as data on every turn. */
  context?: () => Record<string, unknown>;
  onInsertDraft?: (text: string) => void;
  onAfterTurn?: () => void;
  onBack?: () => void;
}

/** Control Tower surface of the shared copilot: the administrator AI (requires operations.admin). */
export function ControlTowerCopilotPanel({ user, activityAt, context, onInsertDraft, onAfterTurn, onBack }: Props) {
  const surface = useMemo<CopilotSurfaceConfig>(
    () => ({
      surfaceId: 'company',
      preferenceKey: 'surfaceModes.control_tower',
      endpoints: {
        thread: OPERATIONS_COPILOT_ENDPOINTS.controlTower,
        proposal: OPERATIONS_COPILOT_ENDPOINTS.proposal,
      },
      activityAt,
      draftTool: AREA_DRAFT_TOOL,
      starters: [...CONTROL_TOWER_STARTERS],
      minAutoIntervalMs: CONTROL_TOWER_COPILOT_MIN_AUTO_INTERVAL_MS,
      copy: {
        eventOpen: 'Revisé la operación al abrir el Control Tower',
        eventInbound: 'Hubo movimiento en la operación · reanalicé',
        statusActive: 'Atento a la operación',
        emptyOnDemand: 'Estoy aquí. Pregúntame qué expedientes están atorados, quién bloquea entregas o qué pasa si un área se retrasa.',
        emptyPaused: 'El copiloto del Control Tower está apagado. No analizaré la operación hasta que lo actives.',
      },
    }),
    [activityAt]
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
