'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Menu, Monitor, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';
import { AssistantSidebar } from './AssistantSidebar';
import { AssistantWorkspace } from './AssistantWorkspace';

export interface AssistantPageClientProps {
  user: CurrentUser;
}

export function AssistantPageClient({ user }: AssistantPageClientProps) {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get('c');
  const [activeId, setActiveId] = useState<string | null>(requestedId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Agent workspace — third column. Open by default; on narrow screens it
  // becomes a right overlay panel (CSS) so the chat keeps full width.
  const [workspaceOpen, setWorkspaceOpen] = useState(true);

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

      {/* Agent workspace — live feed of pages, virtual-computer screen, files. */}
      {!workspaceOpen && (
        <button
          type="button"
          className="assistant-workspace-toggle"
          onClick={() => setWorkspaceOpen(true)}
          aria-label="Abrir espacio de trabajo del agente"
          title="Espacio de trabajo"
        >
          <Monitor size={18} />
        </button>
      )}
      {workspaceOpen && (
        <div className="assistant-workspace-col">
          <AssistantWorkspace
            conversationId={activeId}
            onClose={() => setWorkspaceOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
