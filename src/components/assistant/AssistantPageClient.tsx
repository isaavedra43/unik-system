'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';
import { AssistantSidebar } from './AssistantSidebar';

export interface AssistantPageClientProps {
  user: CurrentUser;
}

export function AssistantPageClient({ user }: AssistantPageClientProps) {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get('c');
  const [activeId, setActiveId] = useState<string | null>(requestedId);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Deep link from a notification ("the assistant finished"): open that thread.
  useEffect(() => {
    if (requestedId) setActiveId(requestedId);
  }, [requestedId]);

  return (
    <div className="assistant-page-body">
      {/* Mobile sidebar toggle */}
      <button
        type="button"
        className="assistant-sidebar-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="Ver conversaciones"
      >
        <Menu size={18} />
        <span>Conversaciones</span>
      </button>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="assistant-sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — becomes drawer on mobile */}
      <div className={`assistant-sidebar-wrapper ${sidebarOpen ? 'open' : ''}`}>
        <div className="assistant-sidebar-header-mobile">
          <span>Conversaciones</span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>
        <AssistantSidebar
          userId={user.id}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id || null);
            setSidebarOpen(false);
          }}
        />
      </div>

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
