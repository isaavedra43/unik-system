'use client';

import React, { useState } from 'react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';
import { AssistantSidebar } from './AssistantSidebar';

export interface AssistantPageClientProps {
  user: CurrentUser;
}

export function AssistantPageClient({ user }: AssistantPageClientProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <div className="assistant-page-body">
      <AssistantSidebar
        userId={user.id}
        activeId={activeId}
        onSelect={(id) => setActiveId(id || null)}
      />
      <div className="assistant-page-main">
        <AssistantChat
          conversationId={activeId}
          context={{ page: '/app/assistant' }}
          user={user}
          onConversationCreated={setActiveId}
        />
      </div>
    </div>
  );
}
