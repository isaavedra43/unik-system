'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, MoreVertical, Users } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ChatChannelDTO, ChatMessageDTO, ChatStreamEvent } from '@/modules/chat/chat-events';
import { ChatMessageList } from './ChatMessageList';
import { ChatMessageInput } from './ChatMessageInput';
import { ChatGroupSettings } from './ChatGroupSettings';
import { ChatCallButton } from './ChatCallButton';
import { ChatCallDialog } from './ChatCallDialog';
import { ChatIncomingCallDialog } from './ChatIncomingCallDialog';
import { ChatThreadPanel } from './ChatThreadPanel';
import type { ChatCallDTO } from '@/modules/chat/chat-events';

export interface ChatConversationProps {
  channelId: string;
  user: CurrentUser;
  onRefresh: () => void;
  onBack?: () => void;
}

export function ChatConversation({ channelId, user, onRefresh, onBack }: ChatConversationProps) {
  const [channel, setChannel] = useState<ChatChannelDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Map<string, { name: string; preview?: string }>>(
    new Map()
  );
  const [replyTo, setReplyTo] = useState<ChatMessageDTO | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [activeThread, setActiveThread] = useState<{
    threadId: string;
    rootMessage: ChatMessageDTO;
  } | null>(null);
  const [incomingCall, setIncomingCall] = useState<ChatCallDTO | null>(null);
  const [activeCall, setActiveCall] = useState<{
    callData: ChatCallDTO;
    role: 'caller' | 'callee';
  } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const oldestMessageDate = useRef<string | null>(null);

  // Load channel info
  useEffect(() => {
    let active = true;
    async function loadChannel() {
      try {
        const res = await fetch(`/app/chat/api/channels/${channelId}`);
        if (res.ok && active) {
          const data = await res.json();
          setChannel(data);
        }
      } catch {
        // silent
      }
    }
    loadChannel();
    return () => {
      active = false;
    };
  }, [channelId]);

  // Load messages
  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channelId}/messages?limit=50`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
        setHasMore(data.hasMore);
        if (data.messages.length > 0) {
          oldestMessageDate.current = data.messages[0].createdAt;
        }
      } else if (res.status === 403) {
        setError('No tienes acceso a este canal');
      }
    } catch {
      setError('Error al cargar los mensajes');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    loadMessages();
    setReplyTo(null);
    setTypingUsers(new Map());
  }, [loadMessages, channelId]);

  // SSE connection
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/app/chat/api/channels/${channelId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const evt: ChatStreamEvent = JSON.parse(event.data);
        switch (evt.type) {
          case 'message':
            setMessages((prev) => {
              // Avoid duplicates
              if (prev.some((m) => m.id === evt.data.id)) return prev;
              return [...prev, evt.data];
            });
            // Auto mark as read
            fetch(`/app/chat/api/channels/${channelId}/read`, { method: 'POST' }).catch(() => {});
            onRefresh();
            break;
          case 'edit':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === evt.data.messageId
                  ? { ...m, content: evt.data.content, editedAt: evt.data.editedAt }
                  : m
              )
            );
            break;
          case 'delete':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === evt.data.messageId
                  ? { ...m, deletedAt: new Date().toISOString(), content: null }
                  : m
              )
            );
            break;
          case 'reaction':
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== evt.data.messageId) return m;
                if (evt.data.action === 'add') {
                  const existing = m.reactions.find(
                    (r) => r.userId === evt.data.userId && r.emoji === evt.data.emoji
                  );
                  if (existing) return m;
                  return {
                    ...m,
                    reactions: [
                      ...m.reactions,
                      {
                        emoji: evt.data.emoji,
                        userId: evt.data.userId,
                        userName: evt.data.userName,
                      },
                    ],
                  };
                } else {
                  return {
                    ...m,
                    reactions: m.reactions.filter(
                      (r) => !(r.userId === evt.data.userId && r.emoji === evt.data.emoji)
                    ),
                  };
                }
              })
            );
            break;
          case 'typing':
            setTypingUsers((prev) => {
              const next = new Map(prev);
              if (evt.data.isTyping) {
                next.set(evt.data.userId, { name: evt.data.userName, preview: evt.data.preview });
              } else {
                next.delete(evt.data.userId);
              }
              return next;
            });
            break;
          case 'call_invite':
            // Call invite received — show incoming call dialog if we're a participant
            if (evt.data.participants.some((p) => p.userId === user.id) && !activeCall) {
              setIncomingCall(evt.data);
            }
            break;
          case 'call_end':
            // Call ended — close dialogs
            setIncomingCall(null);
            if (activeCall) {
              setActiveCall(null);
            }
            break;
          case 'webrtc_signal':
            // WebRTC signal — handled by ChatCallDialog polling
            break;
          case 'presence':
            setChannel((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                members: prev.members.map((m) =>
                  m.userId === evt.data.userId ? { ...m, status: evt.data.status } : m
                ),
              };
            });
            break;
          case 'heartbeat':
            // keep-alive
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [channelId, onRefresh]);

  // Load more (older messages)
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !oldestMessageDate.current) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/app/chat/api/channels/${channelId}/messages?limit=50&cursor=${encodeURIComponent(oldestMessageDate.current)}`
      );
      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [...data.messages, ...prev]);
        setHasMore(data.hasMore);
        if (data.messages.length > 0) {
          oldestMessageDate.current = data.messages[0].createdAt;
        } else {
          setHasMore(false);
        }
      }
    } catch {
      // silent
    } finally {
      setLoadingMore(false);
    }
  }, [channelId, hasMore, loadingMore]);

  // Send message
  const handleSend = useCallback(
    async (
      content: string,
      attachmentIds?: string[],
      extra?: {
        location?: { latitude: number; longitude: number; label?: string };
        poll?: {
          question: string;
          options: string[];
          isMulti: boolean;
          isAnonymous: boolean;
        };
        event?: {
          title: string;
          description?: string;
          startsAt: string;
          endsAt?: string;
          location?: string;
        };
        priority?: 'normal' | 'urgent';
        threadId?: string;
      }
    ) => {
      try {
        const res = await fetch(`/app/chat/api/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: content || null,
            replyToId: replyTo?.id ?? null,
            attachmentIds,
            location: extra?.location ?? null,
            poll: extra?.poll ?? null,
            event: extra?.event ?? null,
            priority: extra?.priority ?? 'normal',
            threadId: extra?.threadId ?? null,
          }),
        });
        if (res.ok) {
          const msg = await res.json();
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
          setReplyTo(null);
          onRefresh();
        }
      } catch {
        // silent
      }
    },
    [channelId, replyTo, onRefresh]
  );

  // Typing indicator
  const handleTyping = useCallback(
    (isTyping: boolean, preview?: string) => {
      fetch(`/app/chat/api/channels/${channelId}/typing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTyping, preview: isTyping ? preview : undefined }),
      }).catch(() => {});
    },
    [channelId]
  );

  // Reactions
  const handleReaction = useCallback(async (messageId: string, emoji: string) => {
    try {
      await fetch(`/app/chat/api/messages/${messageId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
    } catch {
      // silent
    }
  }, []);

  const handleRemoveReaction = useCallback(async (messageId: string, emoji: string) => {
    try {
      await fetch(
        `/app/chat/api/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`,
        {
          method: 'DELETE',
        }
      );
    } catch {
      // silent
    }
  }, []);

  // Edit
  const handleEdit = useCallback(async (messageId: string, content: string) => {
    try {
      await fetch(`/app/chat/api/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    } catch {
      // silent
    }
  }, []);

  // Delete
  const handleDelete = useCallback(async (messageId: string) => {
    try {
      await fetch(`/app/chat/api/messages/${messageId}`, { method: 'DELETE' });
    } catch {
      // silent
    }
  }, []);

  // Incoming call handlers
  const handleAcceptCall = useCallback(async () => {
    if (!incomingCall) return;
    const callData = incomingCall;
    setIncomingCall(null);
    setActiveCall({ callData, role: 'callee' });
  }, [incomingCall]);

  const handleDeclineCall = useCallback(async () => {
    if (!incomingCall) return;
    try {
      await fetch(`/app/chat/api/calls/${incomingCall.id}/decline`, {
        method: 'POST',
      });
    } catch {
      // silent
    }
    setIncomingCall(null);
  }, [incomingCall]);

  const handleCloseCall = useCallback(() => {
    setActiveCall(null);
  }, []);

  // Forward
  const handleForward = useCallback(
    async (messageId: string, targetChannelIds: string[]) => {
      try {
        const res = await fetch(`/app/chat/api/messages/${messageId}/forward`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetChannelIds }),
        });
        if (res.ok) {
          onRefresh();
        }
      } catch {
        // silent
      }
    },
    [onRefresh]
  );

  // Bookmark
  const handleBookmark = useCallback(async (messageId: string) => {
    try {
      await fetch('/app/chat/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
    } catch {
      // silent
    }
  }, []);

  const handleUnbookmark = useCallback(async (messageId: string) => {
    try {
      await fetch(`/app/chat/api/bookmarks?messageId=${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
      });
    } catch {
      // silent
    }
  }, []);

  // Pin
  const handlePin = useCallback(
    async (messageId: string) => {
      try {
        await fetch(`/app/chat/api/channels/${channelId}/pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId }),
        });
      } catch {
        // silent
      }
    },
    [channelId]
  );

  const handleUnpin = useCallback(
    async (messageId: string) => {
      try {
        await fetch(
          `/app/chat/api/channels/${channelId}/pin?messageId=${encodeURIComponent(messageId)}`,
          { method: 'DELETE' }
        );
      } catch {
        // silent
      }
    },
    [channelId]
  );

  // Translate
  const handleTranslate = useCallback(async (messageId: string) => {
    try {
      const res = await fetch('/app/chat/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, targetLang: 'es' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.translation) {
          // Show translation in an alert or update message — for now, use alert
          alert(`Traducción:\n${data.translation}`);
        }
      } else {
        const data = await res.json();
        alert(data.error || 'No se pudo traducir el mensaje');
      }
    } catch {
      // silent
    }
  }, []);

  // Vote poll
  const handleVotePoll = useCallback(async (pollId: string, optionIds: string[]) => {
    try {
      await fetch(`/app/chat/api/polls/${pollId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionIds }),
      });
    } catch {
      // silent
    }
  }, []);

  // RSVP event
  const handleRsvpEvent = useCallback(async (eventId: string, status: 'yes' | 'no' | 'maybe') => {
    try {
      await fetch(`/app/chat/api/events/${eventId}/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {
      // silent
    }
  }, []);

  // Channel display info
  const getChannelName = () => {
    if (!channel) return '';
    if (channel.type === 'group') return channel.name ?? 'Grupo';
    const other = channel.members.find((m) => m.userId !== user.id);
    return other?.name ?? 'Usuario';
  };

  const getChannelSubtitle = () => {
    if (!channel) return '';
    if (channel.type === 'group') {
      return `${channel.members.length} miembros`;
    }
    const other = channel.members.find((m) => m.userId !== user.id);
    if (!other) return '';
    if (other.status === 'online') return 'en línea';
    if (other.status === 'away') return 'ausente';
    return 'desconectado';
  };

  const getChannelAvatar = () => {
    if (!channel) return null;
    if (channel.type === 'group') return <Users size={20} />;
    const other = channel.members.find((m) => m.userId !== user.id);
    return other?.name.slice(0, 2).toUpperCase() ?? '??';
  };

  const otherUserOnline =
    channel?.type === 'dm' &&
    channel.members.find((m) => m.userId !== user.id)?.status === 'online';

  const typingText = Array.from(typingUsers.entries())
    .filter(([uid]) => uid !== user.id)
    .map(([, info]) => info.name)
    .join(', ');

  const typingPreview = Array.from(typingUsers.entries())
    .filter(([uid]) => uid !== user.id)
    .map(([, info]) => info.preview)
    .find((p) => p && p.length > 0);

  return (
    <div className="chat-conversation">
      {/* Header */}
      <div className="chat-conversation-header">
        <button
          type="button"
          className="chat-back-btn"
          onClick={() => (onBack ? onBack() : onRefresh())}
          aria-label="Volver"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="chat-conversation-avatar">
          {getChannelAvatar()}
          {otherUserOnline && <span className="chat-sidebar-presence online" />}
        </div>
        <div className="chat-conversation-info">
          <div className="chat-conversation-name">{getChannelName()}</div>
          <div className="chat-conversation-subtitle">
            {typingText ? (
              <span className="chat-typing-indicator">
                <span className="chat-typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
                {typingText} está escribiendo
                {typingPreview && <span className="chat-typing-preview">: {typingPreview}</span>}
              </span>
            ) : (
              getChannelSubtitle()
            )}
          </div>
        </div>
        {channel && (
          <ChatCallButton channelId={channelId} members={channel.members} currentUserId={user.id} />
        )}
        <button
          type="button"
          className="chat-conversation-settings-btn"
          onClick={() => setShowSettings(true)}
          aria-label="Configuración"
        >
          <MoreVertical size={18} />
        </button>
      </div>

      {/* Messages */}
      <ChatMessageList
        messages={messages}
        loading={loading}
        error={error}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        currentUserId={user.id}
        onReply={setReplyTo}
        onReaction={handleReaction}
        onRemoveReaction={handleRemoveReaction}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onForward={handleForward}
        onBookmark={handleBookmark}
        onUnbookmark={handleUnbookmark}
        onPin={handlePin}
        onUnpin={handleUnpin}
        onTranslate={handleTranslate}
        onVotePoll={handleVotePoll}
        onRsvpEvent={handleRsvpEvent}
        onOpenThread={(threadId, rootMessage) => setActiveThread({ threadId, rootMessage })}
        channelId={channelId}
      />

      {/* Input */}
      <ChatMessageInput
        onSend={handleSend}
        onTyping={handleTyping}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        channelId={channelId}
        user={user}
        members={channel?.members}
        threadId={activeThread?.threadId}
      />

      {/* Thread panel */}
      {activeThread && (
        <ChatThreadPanel
          threadId={activeThread.threadId}
          rootMessage={activeThread.rootMessage}
          channelId={channelId}
          user={user}
          onClose={() => setActiveThread(null)}
        />
      )}

      {/* Settings drawer */}
      {showSettings && channel && (
        <ChatGroupSettings
          channel={channel}
          user={user}
          onClose={() => setShowSettings(false)}
          onRefresh={() => {
            // Reload channel info
            fetch(`/app/chat/api/channels/${channelId}`)
              .then((r) => r.json())
              .then(setChannel)
              .catch(() => {});
            onRefresh();
          }}
        />
      )}

      {/* Incoming call notification */}
      {incomingCall && (
        <ChatIncomingCallDialog
          call={incomingCall}
          onAccept={handleAcceptCall}
          onDecline={handleDeclineCall}
        />
      )}

      {/* Active call dialog (callee mode) */}
      {activeCall && activeCall.role === 'callee' && (
        <ChatCallDialog
          channelId={channelId}
          type={activeCall.callData.type}
          participants={activeCall.callData.participants.map((p) => ({
            userId: p.userId,
            name: p.name,
          }))}
          currentUserId={user.id}
          onClose={handleCloseCall}
          role="callee"
          callData={activeCall.callData}
        />
      )}
    </div>
  );
}
