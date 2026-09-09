'use client';

import React, { useState } from 'react';
import { Phone, Video } from 'lucide-react';
import { ChatCallDialog } from './ChatCallDialog';
import type { ChatChannelMemberDTO } from '@/modules/chat/chat-events';

export interface ChatCallButtonProps {
  channelId: string;
  members: ChatChannelMemberDTO[];
  currentUserId: string;
}

export function ChatCallButton({ channelId, members, currentUserId }: ChatCallButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [callType, setCallType] = useState<'audio' | 'video'>('audio');

  const otherMembers = members.filter((m) => m.userId !== currentUserId);

  if (otherMembers.length === 0) return null;

  const handleStartCall = (type: 'audio' | 'video') => {
    setCallType(type);
    setShowDialog(true);
  };

  return (
    <>
      <div className="chat-call-btn-group">
        <button
          type="button"
          className="chat-call-btn"
          onClick={() => handleStartCall('audio')}
          aria-label="Llamada de voz"
          title="Llamada de voz"
        >
          <Phone size={16} />
        </button>
        <button
          type="button"
          className="chat-call-btn"
          onClick={() => handleStartCall('video')}
          aria-label="Llamada de video"
          title="Llamada de video"
        >
          <Video size={16} />
        </button>
      </div>
      {showDialog && (
        <ChatCallDialog
          channelId={channelId}
          type={callType}
          participants={otherMembers.map((m) => ({ userId: m.userId, name: m.name }))}
          currentUserId={currentUserId}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}
