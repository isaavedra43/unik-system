'use client';

import React from 'react';
import { MessageCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

export interface ChatEmptyStateProps {
  onNewChat: () => void;
}

export function ChatEmptyState({ onNewChat }: ChatEmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <MessageCircle size={48} />
      </div>
      <h3 className="empty-state-title">Tu chat interno</h3>
      <p>Selecciona una conversación o inicia una nueva para empezar a chatear con tu equipo</p>
      <div style={{ marginTop: '1rem' }}>
        <Button onClick={onNewChat} icon={<Plus size={18} />}>
          Nuevo chat
        </Button>
      </div>
    </div>
  );
}
