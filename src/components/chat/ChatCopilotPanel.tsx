'use client';

import React, { useMemo } from 'react';
import { CopilotPanel as SharedCopilotPanel, type CopilotSurfaceConfig } from '@/components/copilot/CopilotPanel';

interface Props {
  channelId: string;
  user: { id: string; name: string };
  /** ISO time of the last message written by someone else in the channel. */
  activityAt: string | null;
  onInsertDraft: (text: string) => void;
  onAfterTurn?: () => void;
  onBack?: () => void;
}

const STARTERS = [
  'Resume lo que se ha hablado',
  '¿Qué me están pidiendo?',
  'Redacta una respuesta',
  'Busca en UNIK lo que mencionan',
];

/** Internal-chat surface of the shared copilot. */
export function ChatCopilotPanel({ channelId, user, activityAt, onInsertDraft, onAfterTurn, onBack }: Props) {
  const surface = useMemo<CopilotSurfaceConfig>(
    () => ({
      surfaceId: channelId,
      preferenceKey: 'chatCopilotMode',
      endpoints: {
        thread: `/app/chat/api/channels/${channelId}/copilot`,
        proposal: (id) => `/app/chat/api/copilot/proposals/${id}`,
      },
      activityAt,
      draftTool: 'proposeChatDraft',
      starters: STARTERS,
      copy: {
        eventOpen: 'Revisé el canal al abrirlo',
        eventInbound: 'Alguien escribió · reanalicé',
        statusActive: 'Atento al canal',
        emptyOnDemand: 'Estoy aquí. Pídeme que resuma, que redacte una respuesta o que busque algo en UNIK.',
        emptyPaused: 'El copiloto del chat interno está apagado. No analizaré ni responderé aquí hasta que lo actives.',
      },
    }),
    [channelId, activityAt]
  );

  return (
    <SharedCopilotPanel
      surface={surface}
      user={user}
      onInsertDraft={onInsertDraft}
      onSendDraft={async (text) => {
        const res = await fetch(`/app/chat/api/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? 'No se pudo enviar el mensaje');
        }
        onAfterTurn?.();
      }}
      onAfterTurn={onAfterTurn}
      onBack={onBack}
    />
  );
}
