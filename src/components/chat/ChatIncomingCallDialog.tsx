'use client';

import React from 'react';
import { Phone, Video, PhoneOff } from 'lucide-react';
import type { ChatCallDTO } from '@/modules/chat/chat-events';

export interface ChatIncomingCallDialogProps {
  call: ChatCallDTO;
  onAccept: () => void;
  onDecline: () => void;
}

export function ChatIncomingCallDialog({ call, onAccept, onDecline }: ChatIncomingCallDialogProps) {
  const isVideo = call.type === 'video';

  return (
    <div className="chat-incoming-call-overlay">
      <div className="chat-incoming-call-dialog">
        <div className="chat-incoming-call-avatar">
          {isVideo ? <Video size={40} /> : <Phone size={40} />}
        </div>
        <div className="chat-incoming-call-info">
          <div className="chat-incoming-call-type">
            {isVideo ? 'Videollamada entrante' : 'Llamada entrante'}
          </div>
          <div className="chat-incoming-call-name">{call.callerName}</div>
          <div className="chat-incoming-call-pulse">
            <span className="chat-incoming-call-dot" />
            <span>Llamando...</span>
          </div>
        </div>
        <div className="chat-incoming-call-actions">
          <button
            type="button"
            className="chat-incoming-call-decline"
            onClick={onDecline}
            aria-label="Rechazar"
          >
            <PhoneOff size={24} />
          </button>
          <button
            type="button"
            className="chat-incoming-call-accept"
            onClick={onAccept}
            aria-label="Aceptar"
          >
            {isVideo ? <Video size={24} /> : <Phone size={24} />}
          </button>
        </div>
      </div>
    </div>
  );
}
