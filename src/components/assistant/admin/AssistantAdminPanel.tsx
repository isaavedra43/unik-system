'use client';

import React, { useState } from 'react';
import { AssistantAdminOverview } from './AssistantAdminOverview';
import { AssistantAdminConversations } from './AssistantAdminConversations';
import { AssistantAdminMessages } from './AssistantAdminMessages';
import { AssistantAdminToolCalls } from './AssistantAdminToolCalls';
import { AssistantAdminApiCalls } from './AssistantAdminApiCalls';
import { AssistantAdminConfig } from './AssistantAdminConfig';
import { AssistantAdminUsers } from './AssistantAdminUsers';
import { AssistantAdminHealth } from './AssistantAdminHealth';

export interface AssistantAdminPanelProps {
  canManage: boolean;
}

type TabId =
  | 'overview'
  | 'conversations'
  | 'messages'
  | 'tool-calls'
  | 'api-calls'
  | 'users'
  | 'config'
  | 'health';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Resumen' },
  { id: 'conversations', label: 'Conversaciones' },
  { id: 'messages', label: 'Mensajes' },
  { id: 'tool-calls', label: 'Tools' },
  { id: 'api-calls', label: 'Llamadas API' },
  { id: 'users', label: 'Usuarios' },
  { id: 'config', label: 'Configuración' },
  { id: 'health', label: 'Salud' },
];

export function AssistantAdminPanel({ canManage }: AssistantAdminPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  return (
    <div className="assistant-admin-panel">
      <div className="assistant-admin-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`assistant-admin-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="assistant-admin-tab-content">
        {activeTab === 'overview' && <AssistantAdminOverview />}
        {activeTab === 'conversations' && <AssistantAdminConversations />}
        {activeTab === 'messages' && <AssistantAdminMessages />}
        {activeTab === 'tool-calls' && <AssistantAdminToolCalls />}
        {activeTab === 'api-calls' && <AssistantAdminApiCalls />}
        {activeTab === 'users' && <AssistantAdminUsers />}
        {activeTab === 'config' && <AssistantAdminConfig canManage={canManage} />}
        {activeTab === 'health' && <AssistantAdminHealth canManage={canManage} />}
      </div>
    </div>
  );
}
