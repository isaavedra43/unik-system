'use client';

import React, { useMemo } from 'react';
import { CopilotPanel, type CopilotSurfaceConfig } from '@/components/copilot/CopilotPanel';
import {
  AREA_DRAFT_TOOL,
  MYWORK_COPILOT_MIN_AUTO_INTERVAL_MS,
  OPERATIONS_COPILOT_ENDPOINTS,
  myWorkStarters,
} from './copilot-starters';

interface Props {
  user: { id: string; name: string };
  /** ISO time of the latest change of the user's work items made by someone else. */
  activityAt: string | null;
  /** `inventory.count`: only then the copilot offers to register a count. */
  canCount?: boolean;
  /** The visible list (view, totals and first rows): sent as data on every turn. */
  context?: () => Record<string, unknown>;
  onInsertDraft?: (text: string) => void;
  onAfterTurn?: () => void;
  onBack?: () => void;
}

/** "Mi trabajo" surface of the shared copilot: the personal AI of each user (plan 5.7). */
export function MyWorkCopilotPanel({ user, activityAt, canCount = false, context, onInsertDraft, onAfterTurn, onBack }: Props) {
  const surface = useMemo<CopilotSurfaceConfig>(
    () => ({
      surfaceId: user.id,
      preferenceKey: 'surfaceModes.mywork',
      endpoints: {
        thread: OPERATIONS_COPILOT_ENDPOINTS.mywork,
        proposal: OPERATIONS_COPILOT_ENDPOINTS.proposal,
      },
      activityAt,
      draftTool: AREA_DRAFT_TOOL,
      starters: myWorkStarters({ canCount }),
      minAutoIntervalMs: MYWORK_COPILOT_MIN_AUTO_INTERVAL_MS,
      copy: {
        eventOpen: 'Revisé tus pendientes al abrir Mi trabajo',
        eventInbound: 'Cambiaron tus pendientes · reordené',
        statusActive: 'Atento a tus pendientes',
        emptyOnDemand: canCount
          ? 'Estoy aquí. Pregúntame qué hacer primero, pídeme registrar un conteo o qué te falta para cerrar hoy.'
          : 'Estoy aquí. Pregúntame qué hacer primero o qué te falta para cerrar hoy.',
        emptyPaused: 'El copiloto de Mi trabajo está apagado. No revisaré tus pendientes hasta que lo actives.',
      },
    }),
    [user.id, activityAt, canCount]
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
