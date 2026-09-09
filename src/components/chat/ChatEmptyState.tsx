'use client';

import React from 'react';
import { MessageCircle, Plus } from 'lucide-react';

export interface ChatEmptyStateProps {
  onNewChat: () => void;
}

export function ChatEmptyState({ onNewChat }: ChatEmptyStateProps) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        <MessageCircle size={48} />
      </div>
      <h2 className="chat-empty-title">Tu chat interno</h2>
      <p className="chat-empty-subtitle">
        Selecciona una conversación o inicia una nueva para empezar a chatear con tu equipo
      </p>
      <button type="button" className="chat-empty-cta" onClick={onNewChat}>
        <Plus size={18} />
        Nuevo chat
      </button>
    </div>
  );
}
