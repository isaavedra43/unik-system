'use client';

import React from 'react';
import { MessageCircle } from 'lucide-react';

export function ChatEmptyState() {
  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-icon">
        <MessageCircle size={48} />
      </div>
      <h3 className="chat-empty-state-title">Chat interno UNIK</h3>
      <p className="chat-empty-state-text">
        Selecciona una conversación o inicia un nuevo chat desde el panel lateral
      </p>
    </div>
  );
}
