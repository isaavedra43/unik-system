'use client';

import React, { useMemo } from 'react';
import { CopilotPanel, type CopilotSurfaceConfig } from '@/components/copilot/CopilotPanel';
import {
  AREA_DRAFT_TOOL,
  CASE_COPILOT_MIN_AUTO_INTERVAL_MS,
  CASE_ROOM_STARTERS,
  OPERATIONS_COPILOT_ENDPOINTS,
} from './copilot-starters';

interface Props {
  caseId: string;
  /** Visible label of the case, e.g. "EXP-120 · Constructora Norte". */
  caseLabel?: string | null;
  user: { id: string; name: string };
  /** ISO time of the latest event of the case. */
  activityAt: string | null;
  /** Extra host data sent on every turn (e.g. the timeline filter the user is looking at). */
  context?: () => Record<string, unknown>;
  onInsertDraft?: (text: string) => void;
  onAfterTurn?: () => void;
  onBack?: () => void;
}

/** Case (expediente) surface of the shared copilot: Expediente 360 and the case room. */
export function CaseRoomCopilotPanel({ caseId, caseLabel, user, activityAt, context, onInsertDraft, onAfterTurn, onBack }: Props) {
  const noun = caseLabel?.trim() ? caseLabel.trim() : 'este expediente';
  const surface = useMemo<CopilotSurfaceConfig>(
    () => ({
      surfaceId: caseId,
      preferenceKey: 'surfaceModes.case',
      endpoints: {
        thread: OPERATIONS_COPILOT_ENDPOINTS.case(caseId),
        proposal: OPERATIONS_COPILOT_ENDPOINTS.proposal,
      },
      activityAt,
      draftTool: AREA_DRAFT_TOOL,
      starters: [...CASE_ROOM_STARTERS],
      minAutoIntervalMs: CASE_COPILOT_MIN_AUTO_INTERVAL_MS,
      copy: {
        eventOpen: `Revisé ${noun} al abrirlo`,
        eventInbound: 'Hubo actividad en el expediente · reanalicé',
        statusActive: `Atento a ${noun}`,
        emptyOnDemand: `Estoy aquí. Pregúntame qué detiene ${noun}, quién tiene el siguiente paso o si llegamos a la fecha prometida.`,
        emptyPaused: 'El copiloto de expedientes está apagado. No analizaré este expediente hasta que lo actives.',
      },
    }),
    [caseId, noun, activityAt]
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
