'use client';

import React from 'react';
import { Bot, User as UserIcon, FileText, Image as ImageIcon } from 'lucide-react';
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
}

export function AssistantMessage({ message }: AssistantMessageProps) {
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
        <div className="assistant-msg-content">
          {message.content && <AssistantMarkdown content={message.content} />}
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
