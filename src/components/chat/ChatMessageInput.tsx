'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Paperclip, Send, Smile, X, CornerUpRight } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ChatMessageDTO } from '@/modules/chat/chat-events';
import { ChatPendingAttachment } from './ChatAttachmentPreview';

export interface ChatMessageInputProps {
  onSend: (content: string, attachmentIds?: string[]) => void;
  onTyping: (isTyping: boolean) => void;
  replyTo: ChatMessageDTO | null;
  onCancelReply: () => void;
  channelId: string;
  user: CurrentUser;
}

interface PendingUpload {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  progress: number;
  error?: string;
}

const COMMON_EMOJIS = [
  '😀',
  '😂',
  '😍',
  '👍',
  '👎',
  '❤️',
  '🎉',
  '🔥',
  '👏',
  '🙏',
  '💪',
  '🤔',
  '😅',
  '😮',
  '😢',
  '✅',
  '❌',
  '⭐',
];

export function ChatMessageInput({
  onSend,
  onTyping,
  replyTo,
  onCancelReply,
  channelId,
}: ChatMessageInputProps) {
  const [text, setText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [completedAttachmentIds, setCompletedAttachmentIds] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  // Close emoji picker on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const sendTyping = useCallback(
    (typing: boolean) => {
      if (isTypingRef.current !== typing) {
        isTypingRef.current = typing;
        onTyping(typing);
      }
    },
    [onTyping]
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (e.target.value.length > 0) {
      sendTyping(true);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => sendTyping(false), 3000);
    } else {
      sendTyping(false);
    }
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && completedAttachmentIds.length === 0) return;
    onSend(trimmed, completedAttachmentIds.length > 0 ? completedAttachmentIds : undefined);
    setText('');
    setCompletedAttachmentIds([]);
    sendTyping(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
            // Remove from pending after a short delay
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

      <div className="chat-input-row">
        {/* Attach button */}
        <button
          type="button"
          className="chat-input-btn"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Adjuntar archivo"
        >
          <Paperclip size={20} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileInputChange}
          accept="image/*,video/*,audio/*,.pdf,.txt,.csv,.xlsx,.docx,.zip"
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          className="chat-input-textarea"
          placeholder="Escribe un mensaje..."
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          aria-label="Mensaje"
        />

        {/* Emoji button */}
        <div className="chat-input-emoji-wrapper" ref={emojiRef}>
          <button
            type="button"
            className="chat-input-btn"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            aria-label="Emojis"
          >
            <Smile size={20} />
          </button>
          {showEmojiPicker && (
            <div className="chat-emoji-picker-popup">
              {COMMON_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="chat-emoji-btn"
                  onClick={() => {
                    setText((prev) => prev + emoji);
                    setShowEmojiPicker(false);
                    textareaRef.current?.focus();
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Send button */}
        <button
          type="button"
          className="chat-input-send"
          onClick={handleSend}
          disabled={!text.trim() && completedAttachmentIds.length === 0}
          aria-label="Enviar"
        >
          <Send size={20} />
        </button>
      </div>

      {isDragging && <div className="chat-input-drop-zone">Suelta los archivos aquí</div>}
    </div>
  );
}
