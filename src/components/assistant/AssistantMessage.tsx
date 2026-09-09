'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Bot, User as UserIcon, FileText, Image as ImageIcon, Plus } from 'lucide-react';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AssistantToolCallCard, type ToolCallData } from './AssistantToolCallCard';

export interface AttachmentDisplay {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AssistantMessageData {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallRecords?: Array<{
    id: string;
    toolName: string;
    args: unknown;
    result: unknown;
    durationMs: number;
    success: boolean;
    errorCode: string | null;
  }>;
  attachments?: AttachmentDisplay[];
  createdAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export interface AssistantMessageProps {
  message: AssistantMessageData;
  onAddToChat?: (text: string) => void;
}

export function AssistantMessage({ message, onAddToChat }: AssistantMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [showAddButton, setShowAddButton] = useState(false);
  const [buttonPos, setButtonPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Detect text selection within this message
  const handleSelectionChange = useCallback(() => {
    if (!contentRef.current || !onAddToChat) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setShowAddButton(false);
      return;
    }
    const range = selection.getRangeAt(0);
    // Check if selection is within this message's content
    const container = contentRef.current;
    if (!container.contains(range.commonAncestorContainer)) {
      setShowAddButton(false);
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 2) {
      setShowAddButton(false);
      return;
    }
    // Get selection position relative to the message container
    const rect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setButtonPos({
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.top - containerRect.top - 8,
    });
    setShowAddButton(true);
  }, [onAddToChat]);

  useEffect(() => {
    if (!onAddToChat) return;
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [handleSelectionChange, onAddToChat]);

  const handleAddToChat = useCallback(() => {
    const selection = window.getSelection();
    if (!selection) return;
    const text = selection.toString().trim();
    if (text && onAddToChat) {
      onAddToChat(text);
      selection.removeAllRanges();
      setShowAddButton(false);
    }
  }, [onAddToChat]);

  if (message.role === 'tool') {
    // Tool messages are rendered as cards within the assistant message
    return null;
  }

  const isUser = message.role === 'user';
  const toolCallData: ToolCallData[] = (message.toolCallRecords ?? []).map((tc) => ({
    name: tc.toolName,
    args: tc.args,
    result: tc.result,
    success: tc.success,
    durationMs: tc.durationMs,
    errorCode: tc.errorCode,
  }));

  return (
    <div className={`assistant-msg-row ${isUser ? 'assistant-msg-row-user' : 'assistant-msg-row-assistant'}`}>
      <div className="assistant-msg-avatar">
        {isUser ? <UserIcon size={18} /> : <Bot size={18} />}
      </div>
      <div className={`assistant-msg ${isUser ? 'assistant-msg-user' : 'assistant-msg-assistant'}`}>
        {/* Render attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="assistant-msg-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="assistant-msg-attachment">
                {isImage(att.mimeType) ? (
                  <ImageIcon size={14} className="assistant-msg-attachment-icon" />
                ) : (
                  <FileText size={14} className="assistant-msg-attachment-icon" />
                )}
                <span className="assistant-msg-attachment-name" title={att.fileName}>
                  {att.fileName}
                </span>
                <span className="assistant-msg-attachment-size">{formatSize(att.sizeBytes)}</span>
              </div>
            ))}
          </div>
        )}
        <div ref={contentRef} className="assistant-msg-content" style={{ position: 'relative' }}>
          {message.content && <AssistantMarkdown content={message.content} />}
          {/* Floating "Agregar al chat" button */}
          {showAddButton && onAddToChat && (
            <button
              type="button"
              className="assistant-add-to-chat-btn"
              onClick={handleAddToChat}
              style={{
                position: 'absolute',
                left: `${buttonPos.x}px`,
                top: `${buttonPos.y}px`,
                transform: 'translate(-50%, -100%)',
              }}
              title="Agregar al chat"
            >
              <Plus size={12} />
              <span>Agregar al chat</span>
            </button>
          )}
        </div>
        {toolCallData.map((tc, idx) => (
          <AssistantToolCallCard key={idx} data={tc} />
        ))}
        {message.toolCalls && message.toolCalls.length > 0 && !toolCallData.length && (
          <div className="assistant-msg-toolcalls-pending">
            {message.toolCalls.map((tc) => (
              <div key={tc.id} className="assistant-tool-pending">
                <span className="assistant-tool-pending-name">{tc.name}</span>
                <span className="assistant-tool-pending-spinner">ejecutando…</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
