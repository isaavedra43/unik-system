'use client';

import React, { useMemo } from 'react';
import { CopilotPanel as SharedCopilotPanel, type CopilotSurfaceConfig } from '@/components/copilot/CopilotPanel';
import type { CommConversationDTO, InboxUserInfo } from '../inbox-types';

interface Props {
  conversation: CommConversationDTO;
  user: InboxUserInfo;
  onInsertDraft: (text: string) => void;
  onRefreshConversation: () => void;
  onBack?: () => void;
}

const STARTERS = [
  'Analiza esta conversación',
  '¿Qué le respondo?',
  'Resume lo que pide el cliente',
  'Revisa su expediente en Zoho',
];

/** Inbox (Bandeja externa) surface of the shared copilot. */
export function CopilotPanel({ conversation, user, onInsertDraft, onRefreshConversation, onBack }: Props) {
  const surface = useMemo<CopilotSurfaceConfig>(
    () => ({
      surfaceId: conversation.id,
      endpoints: {
        thread: `/app/inbox/api/conversations/${conversation.id}/copilot`,
        proposal: (id) => `/app/inbox/api/copilot/proposals/${id}`,
      },
      activityAt: conversation.lastInboundAt,
      draftTool: 'proposeInboxDraft',
      starters: STARTERS,
      copy: {
        eventOpen: 'Analicé la conversación al abrirla',
        eventInbound: 'El cliente escribió · reanalicé',
        statusActive: 'Atento a la conversación',
        emptyOnDemand: 'Estoy aquí. Pídeme que analice, dime qué responder o dame instrucciones.',
        emptyPaused: 'El copiloto de bandeja está apagado. No analizaré ni responderé aquí hasta que lo actives.',
      },
    }),
    [conversation.id, conversation.lastInboundAt]
  );

  return (
    <SharedCopilotPanel
      surface={surface}
      user={{ id: user.id, name: user.name }}
      onInsertDraft={onInsertDraft}
      onAfterTurn={onRefreshConversation}
      onBack={onBack}
    />
  );
}
