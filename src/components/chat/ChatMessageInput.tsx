'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Paperclip,
  Send,
  Smile,
  X,
  CornerUpRight,
  AlertCircle,
} from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ChatMessageDTO, ChatChannelMemberDTO } from '@/modules/chat/chat-events';
import { ChatPendingAttachment } from './ChatAttachmentPreview';
import { ChatVoiceRecorder } from './ChatVoiceRecorder';
import { ChatVideoRecorder } from './ChatVideoRecorder';
import { ChatMentionPicker } from './ChatMentionPicker';
import { ChatLocationPicker } from './ChatLocationPicker';
import { ChatPollCreator } from './ChatPollCreator';
import { ChatEventCreator } from './ChatEventCreator';
import { ChatSnippetPicker } from './ChatSnippetPicker';
import { ChatSlashCommands, SLASH_COMMANDS, type ChatSlashCommand } from './ChatSlashCommands';
import { ChatAttachMenu } from './ChatAttachMenu';
import { ChatEmojiPicker } from './ChatEmojiPicker';

export interface ChatMessageInputProps {
  onSend: (
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
  ) => Promise<boolean>;
  onTyping: (isTyping: boolean, preview?: string) => void;
  replyTo: ChatMessageDTO | null;
  onCancelReply: () => void;
  channelId: string;
  user: CurrentUser;
  members?: ChatChannelMemberDTO[];
  threadId?: string | null;
}

interface PendingUpload {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  progress: number;
  error?: string;
}

export function ChatMessageInput({
  onSend,
  onTyping,
  replyTo,
  onCancelReply,
  channelId,
  members,
  threadId,
}: ChatMessageInputProps) {
  const [text, setText] = useState('');
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [completedAttachmentIds, setCompletedAttachmentIds] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [showEventCreator, setShowEventCreator] = useState(false);
  const [showSnippetPicker, setShowSnippetPicker] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [showVideoRecorder, setShowVideoRecorder] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isUrgent, setIsUrgent] = useState(false);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  // Draft persistence — save/restore text per channel via localStorage
  const draftKey = `chat-draft:${channelId}`;
  useEffect(() => {
    // Restore draft on channel switch
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) setText(saved);
    } catch {
      // localStorage unavailable
    }
    return () => {
      // Clear local typing state when leaving channel
      isTypingRef.current = false;
    };
  }, [draftKey]);

  useEffect(() => {
    // Save draft on text change (debounced via microtask)
    if (text) {
      try {
        localStorage.setItem(draftKey, text);
      } catch {
        // localStorage unavailable or quota exceeded
      }
    } else {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // ignore
      }
    }
  }, [text, draftKey]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  const sendTyping = useCallback(
    (typing: boolean, preview?: string) => {
      if (isTypingRef.current !== typing) {
        isTypingRef.current = typing;
        onTyping(typing, preview);
      } else if (typing && preview !== undefined) {
        onTyping(true, preview);
      }
    },
    [onTyping]
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);

    // Detect slash command at start
    if (value.startsWith('/') && !value.includes(' ')) {
      setSlashQuery(value.slice(1));
      setSlashIndex(0);
    } else {
      setSlashQuery(null);
    }

    // Detect @mention
    const cursorPos = e.target.selectionStart;
    const beforeCursor = value.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch && members && members.length > 0) {
      setMentionQuery(atMatch[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }

    if (value.length > 0) {
      sendTyping(true, value.slice(0, 20));
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => sendTyping(false), 3000);
    } else {
      sendTyping(false);
    }
  };

  const handleMentionSelect = (username: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    const newText = beforeCursor.replace(/@(\w*)$/, `@${username} `) + afterCursor;
    setText(newText);
    setMentionQuery(null);
    setTimeout(() => {
      textareaRef.current?.focus();
      const newPos = beforeCursor.replace(/@(\w*)$/, `@${username} `).length;
      textareaRef.current?.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && completedAttachmentIds.length === 0) return;
    if (isSending) return; // prevent duplicate submissions

    setIsSending(true);
    try {
      const success = await onSend(
        trimmed,
        completedAttachmentIds.length > 0 ? completedAttachmentIds : undefined,
        {
          priority: isUrgent ? 'urgent' : 'normal',
          threadId: threadId ?? undefined,
        }
      );
      if (success) {
        setText('');
        setCompletedAttachmentIds([]);
        setIsUrgent(false);
        setSlashQuery(null);
        sendTyping(false);
        // Clear draft from localStorage
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // ignore
        }
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      }
      // On failure: keep text and attachments so user can retry
    } finally {
      setIsSending(false);
    }
  };

  const handleSlashSelect = (cmd: ChatSlashCommand) => {
    if (cmd.command === '/urgente') {
      setIsUrgent((prev) => !prev);
      setText('');
      setSlashQuery(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }
    if (cmd.command === '/encuesta') {
      setShowPollCreator(true);
      setText('');
      setSlashQuery(null);
      return;
    }
    if (cmd.command === '/evento') {
      setShowEventCreator(true);
      setText('');
      setSlashQuery(null);
      return;
    }
    if (cmd.command === '/ubicacion') {
      setShowLocationPicker(true);
      setText('');
      setSlashQuery(null);
      return;
    }
    if (cmd.command === '/voz') {
      // Voice recorder is always visible; just clear the text
      setText('');
      setSlashQuery(null);
      return;
    }
    if (cmd.command === '/video') {
      // Video recorder is always visible; just clear the text
      setText('');
      setSlashQuery(null);
      return;
    }
    if (cmd.command === '/snippet') {
      setShowSnippetPicker(true);
      setText('');
      setSlashQuery(null);
      return;
    }
    if (cmd.command === '/ai') {
      setText('');
      setSlashQuery(null);
      return;
    }
    setText('');
    setSlashQuery(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command navigation
    if (slashQuery !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((prev) => prev + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const filtered = SLASH_COMMANDS.filter(
          (c) =>
            slashQuery === '' ||
            c.command.includes(slashQuery) ||
            c.label.toLowerCase().includes(slashQuery.toLowerCase())
        );
        if (filtered[slashIndex % filtered.length]) {
          handleSlashSelect(filtered[slashIndex % filtered.length]);
        }
        return;
      }
    }
    // Mention navigation
    if (mentionQuery !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => prev + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = useCallback(
    async (files: FileList) => {
      for (const file of Array.from(files)) {
        const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setPendingUploads((prev) => [
          ...prev,
          {
            id: uploadId,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            progress: 0,
          },
        ]);

        try {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('channelId', channelId);

          const res = await fetch('/app/chat/api/upload', {
            method: 'POST',
            body: formData,
          });

          if (res.ok) {
            const data = await res.json();
            setCompletedAttachmentIds((prev) => [...prev, data.id]);
            setPendingUploads((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, progress: 100 } : u))
            );
            setTimeout(() => {
              setPendingUploads((prev) => prev.filter((u) => u.id !== uploadId));
            }, 500);
          } else {
            const err = await res.json();
            setPendingUploads((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, error: err.error || 'Error al subir' } : u
              )
            );
          }
        } catch {
          setPendingUploads((prev) =>
            prev.map((u) => (u.id === uploadId ? { ...u, error: 'Error de red' } : u))
          );
        }
      }
    },
    [channelId]
  );

  const handleVoiceComplete = useCallback(
    async (blob: Blob, durationMs: number) => {
      const uploadId = `voice-${Date.now()}`;
      setPendingUploads((prev) => [
        ...prev,
        {
          id: uploadId,
          fileName: 'mensaje-de-voz.webm',
          mimeType: 'audio/webm',
          sizeBytes: blob.size,
          progress: 0,
        },
      ]);

      try {
        const formData = new FormData();
        formData.append('file', blob, 'mensaje-de-voz.webm');
        formData.append('channelId', channelId);

        const res = await fetch('/app/chat/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (res.ok) {
          const data = await res.json();
          setCompletedAttachmentIds((prev) => [...prev, data.id]);
          setPendingUploads((prev) =>
            prev.map((u) => (u.id === uploadId ? { ...u, progress: 100 } : u))
          );
          setTimeout(() => {
            setPendingUploads((prev) => prev.filter((u) => u.id !== uploadId));
          }, 500);
        } else {
          const err = await res.json();
          setPendingUploads((prev) =>
            prev.map((u) =>
              u.id === uploadId ? { ...u, error: err.error || 'Error al subir audio' } : u
            )
          );
        }
      } catch {
        setPendingUploads((prev) =>
          prev.map((u) => (u.id === uploadId ? { ...u, error: 'Error de red' } : u))
        );
      }
    },
    [channelId]
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFileSelect(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      handleFileSelect(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      handleFileSelect(dt.files);
    }
  };

  const removeAttachment = (id: string) => {
    setCompletedAttachmentIds((prev) => prev.filter((a) => a !== id));
  };

  const handleLocationSend = (location: {
    latitude: number;
    longitude: number;
    label?: string;
  }) => {
    onSend('', undefined, { location });
    setShowLocationPicker(false);
  };

  const handlePollCreate = (poll: {
    question: string;
    options: string[];
    isMulti: boolean;
    isAnonymous: boolean;
  }) => {
    onSend('', undefined, { poll });
    setShowPollCreator(false);
  };

  const handleEventCreate = (event: {
    title: string;
    description?: string;
    startsAt: string;
    endsAt?: string;
    location?: string;
  }) => {
    onSend('', undefined, { event });
    setShowEventCreator(false);
  };

  const handleSnippetSelect = (content: string) => {
    setText((prev) => (prev ? `${prev} ${content}` : content));
    setShowSnippetPicker(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // Filtered members for mention picker
  const filteredMembers = (members ?? [])
    .filter((m) => {
      const q = (mentionQuery ?? '').toLowerCase();
      return q === '' || m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q);
    })
    .slice(0, 8);

  return (
    <div
      className={`chat-input-wrapper ${isDragging ? 'dragging' : ''}`}
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
    >
      {/* Reply preview */}
      {replyTo && (
        <div className="chat-input-reply">
          <CornerUpRight size={16} />
          <div className="chat-input-reply-content">
            <span className="chat-input-reply-sender">{replyTo.senderName}</span>
            <span className="chat-input-reply-text">
              {replyTo.content?.slice(0, 80) ?? '[Archivo]'}
            </span>
          </div>
          <button type="button" onClick={onCancelReply} aria-label="Cancelar respuesta">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Pending uploads */}
      {pendingUploads.length > 0 && (
        <div className="chat-input-pending">
          {pendingUploads.map((u) => (
            <div key={u.id}>
              {u.error ? (
                <div className="chat-att-error">{u.error}</div>
              ) : (
                <ChatPendingAttachment
                  fileName={u.fileName}
                  mimeType={u.mimeType}
                  sizeBytes={u.sizeBytes}
                  progress={u.progress}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Completed attachments preview */}
      {completedAttachmentIds.length > 0 && (
        <div className="chat-input-attachments">
          {completedAttachmentIds.map((id) => (
            <div key={id} className="chat-input-attachment-item">
              <span className="chat-input-attachment-name">Archivo adjunto</span>
              <button type="button" onClick={() => removeAttachment(id)} aria-label="Quitar">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Location picker */}
      {showLocationPicker && (
        <ChatLocationPicker
          onSend={handleLocationSend}
          onCancel={() => setShowLocationPicker(false)}
        />
      )}

      {/* Poll creator */}
      {showPollCreator && (
        <ChatPollCreator onCreate={handlePollCreate} onCancel={() => setShowPollCreator(false)} />
      )}

      {/* Event creator */}
      {showEventCreator && (
        <ChatEventCreator
          onCreate={handleEventCreate}
          onCancel={() => setShowEventCreator(false)}
        />
      )}

      {/* Snippet picker */}
      {showSnippetPicker && (
        <ChatSnippetPicker
          onSelect={handleSnippetSelect}
          onClose={() => setShowSnippetPicker(false)}
        />
      )}

      <div className="chat-input-row">
        {/* Attach menu */}
        <ChatAttachMenu
          onAttachFile={() => fileInputRef.current?.click()}
          onPickLocation={() => setShowLocationPicker(true)}
          onPickPoll={() => setShowPollCreator(true)}
          onPickEvent={() => setShowEventCreator(true)}
          onPickSnippet={() => setShowSnippetPicker(true)}
          onRecordVoice={() => setShowVoiceRecorder(true)}
          onRecordVideo={() => setShowVideoRecorder(true)}
        >
          <button type="button" className="chat-input-btn" aria-label="Adjuntar">
            <Paperclip size={20} />
          </button>
        </ChatAttachMenu>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileInputChange}
          accept="image/*,video/*,audio/*,.pdf,.txt,.csv,.xlsx,.docx,.zip"
        />

        {/* Voice recorder */}
        {showVoiceRecorder && (
          <ChatVoiceRecorder onComplete={handleVoiceComplete} channelId={channelId} />
        )}

        {/* Video recorder */}
        {showVideoRecorder && (
          <ChatVideoRecorder onComplete={handleVoiceComplete} channelId={channelId} />
        )}

        {/* Urgent toggle — only visible when there's text */}
        {text.trim() && (
          <button
            type="button"
            className={`chat-input-btn ${isUrgent ? 'urgent-active' : ''}`}
            onClick={() => setIsUrgent((prev) => !prev)}
            aria-label="Marcar como urgente"
            aria-pressed={isUrgent}
            title={isUrgent ? 'Urgente activado' : 'Marcar como urgente'}
          >
            <AlertCircle size={20} />
          </button>
        )}

        {/* Textarea with mention picker */}
        <div className="chat-input-text-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            placeholder="Escribe un mensaje…"
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            aria-label="Mensaje"
          />
          {slashQuery !== null && (
            <ChatSlashCommands
              query={slashQuery}
              onSelect={handleSlashSelect}
              activeIndex={slashIndex}
            />
          )}
          {mentionQuery !== null && filteredMembers.length > 0 && (
            <ChatMentionPicker
              members={filteredMembers}
              onSelect={handleMentionSelect}
              query={mentionQuery ?? ''}
              activeIndex={mentionIndex}
            />
          )}
        </div>

        {/* Emoji picker */}
        <ChatEmojiPicker
          onSelect={(emoji) => {
            setText((prev) => prev + emoji);
            textareaRef.current?.focus();
          }}
          align="end"
        >
          <button type="button" className="chat-input-btn" aria-label="Emojis">
            <Smile size={20} />
          </button>
        </ChatEmojiPicker>

        {/* Send button */}
        <button
          type="button"
          className="chat-input-send"
          onClick={handleSend}
          disabled={isSending || (!text.trim() && completedAttachmentIds.length === 0)}
          aria-label={isSending ? 'Enviando…' : 'Enviar'}
          aria-busy={isSending}
        >
          <Send size={20} className={isSending ? 'chat-send-spin' : ''} />
        </button>
      </div>

      <div className="chat-input-hint" aria-hidden="true">
        <span>
          <kbd>Enter</kbd> enviar
        </span>
        <span>
          <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea
        </span>
        <span>
          <kbd>/</kbd> comandos
        </span>
        <span>
          <kbd>@</kbd> mencionar
        </span>
      </div>

      {isDragging && <div className="chat-input-drop-zone">Suelta los archivos aquí</div>}
    </div>
  );
}
