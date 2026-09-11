'use client';

import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/shadcn/tabs';
import { ChatAdminOverview } from './ChatAdminOverview';
import { ChatAdminConversations } from './ChatAdminConversations';
import { ChatAdminMessages } from './ChatAdminMessages';
import { ChatAdminUsers } from './ChatAdminUsers';
import { ChatAdminModeration } from './ChatAdminModeration';
import { ChatAdminAlerts } from './ChatAdminAlerts';
import { ChatAdminConfig } from './ChatAdminConfig';
import { ChatAdminCalls } from './ChatAdminCalls';
import { ChatAdminBroadcast } from './ChatAdminBroadcast';
import { ChatAdminAuditLog } from './ChatAdminAuditLog';

export interface ChatAdminPanelProps {
  canManage: boolean;
}

export function ChatAdminPanel({ canManage }: ChatAdminPanelProps) {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="chat-admin-tabs-wrapper">
          <TabsList className="chat-admin-tabs-list">
            <TabsTrigger value="overview">Resumen</TabsTrigger>
            <TabsTrigger value="conversations">Conversaciones</TabsTrigger>
            <TabsTrigger value="messages">Mensajes</TabsTrigger>
            <TabsTrigger value="users">Usuarios</TabsTrigger>
            <TabsTrigger value="calls">Llamadas</TabsTrigger>
            <TabsTrigger value="moderation">Moderación</TabsTrigger>
            <TabsTrigger value="alerts">Alertas</TabsTrigger>
            <TabsTrigger value="broadcast">Anuncios</TabsTrigger>
            <TabsTrigger value="audit">Auditoría</TabsTrigger>
            <TabsTrigger value="config">Configuración</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4">
          <ChatAdminOverview />
        </TabsContent>
        <TabsContent value="conversations" className="mt-4">
          <ChatAdminConversations />
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          <ChatAdminMessages />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <ChatAdminUsers />
        </TabsContent>
        <TabsContent value="calls" className="mt-4">
          <ChatAdminCalls />
        </TabsContent>
        <TabsContent value="moderation" className="mt-4">
          <ChatAdminModeration canManage={canManage} />
        </TabsContent>
        <TabsContent value="alerts" className="mt-4">
          <ChatAdminAlerts canManage={canManage} />
        </TabsContent>
        <TabsContent value="broadcast" className="mt-4">
          <ChatAdminBroadcast canManage={canManage} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <ChatAdminAuditLog />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ChatAdminConfig canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
