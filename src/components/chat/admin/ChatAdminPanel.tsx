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

export interface ChatAdminPanelProps {
  canManage: boolean;
}

export function ChatAdminPanel({ canManage }: ChatAdminPanelProps) {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex-wrap h-auto justify-start">
          <TabsTrigger value="overview">Resumen</TabsTrigger>
          <TabsTrigger value="conversations">Conversaciones</TabsTrigger>
          <TabsTrigger value="messages">Mensajes</TabsTrigger>
          <TabsTrigger value="users">Usuarios</TabsTrigger>
          <TabsTrigger value="moderation">Moderación</TabsTrigger>
          <TabsTrigger value="alerts">Alertas</TabsTrigger>
          <TabsTrigger value="config">Configuración</TabsTrigger>
        </TabsList>

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
        <TabsContent value="moderation" className="mt-4">
          <ChatAdminModeration canManage={canManage} />
        </TabsContent>
        <TabsContent value="alerts" className="mt-4">
          <ChatAdminAlerts canManage={canManage} />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ChatAdminConfig canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
