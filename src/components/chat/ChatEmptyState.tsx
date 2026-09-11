'use client';

import React from 'react';
import { MessageCircle, Users, Phone, Paperclip } from 'lucide-react';

const HINTS = [
  { icon: Users, label: 'Mensajes directos y grupos de trabajo' },
  { icon: Phone, label: 'Llamadas de voz y videollamadas' },
  { icon: Paperclip, label: 'Archivos, encuestas y eventos' },
];

export function ChatEmptyState() {
  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-icon" aria-hidden="true">
        <MessageCircle size={30} />
      </div>
      <h3 className="chat-empty-state-title">Chat interno UNIK</h3>
      <p className="chat-empty-state-text">
        Selecciona una conversación o inicia un nuevo chat desde el panel lateral
      </p>
      <ul className="chat-empty-state-hints">
        {HINTS.map(({ icon: Icon, label }) => (
          <li key={label}>
            <span className="chat-empty-state-hint-icon" aria-hidden="true">
              <Icon size={14} />
            </span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
