'use client';

import React, { useState } from 'react';
import { ChatAdminOverview } from './ChatAdminOverview';
import { ChatAdminConversations } from './ChatAdminConversations';
import { ChatAdminMessages } from './ChatAdminMessages';
import { ChatAdminUsers } from './ChatAdminUsers';
import { ChatAdminModeration } from './ChatAdminModeration';
import { ChatAdminAlerts } from './ChatAdminAlerts';
import { ChatAdminConfig } from './ChatAdminConfig';

export interface ChatAdminPanelProps {
  canManage: boolean;
}

type TabId =
  'overview' | 'conversations' | 'messages' | 'users' | 'moderation' | 'alerts' | 'config';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Resumen' },
  { id: 'conversations', label: 'Conversaciones' },
  { id: 'messages', label: 'Mensajes' },
  { id: 'users', label: 'Usuarios' },
  { id: 'moderation', label: 'Moderación' },
  { id: 'alerts', label: 'Alertas' },
  { id: 'config', label: 'Configuración' },
];

export function ChatAdminPanel({ canManage }: ChatAdminPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  return (
    <div className="chat-admin-panel">
      <div className="chat-admin-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`chat-admin-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="chat-admin-tab-content">
        {activeTab === 'overview' && <ChatAdminOverview />}
        {activeTab === 'conversations' && <ChatAdminConversations />}
        {activeTab === 'messages' && <ChatAdminMessages />}
        {activeTab === 'users' && <ChatAdminUsers />}
        {activeTab === 'moderation' && <ChatAdminModeration canManage={canManage} />}
        {activeTab === 'alerts' && <ChatAdminAlerts canManage={canManage} />}
        {activeTab === 'config' && <ChatAdminConfig canManage={canManage} />}
      </div>
    </div>
  );
}
