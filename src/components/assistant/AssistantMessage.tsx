'use client';

import React from 'react';
import { Bot, User as UserIcon } from 'lucide-react';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AssistantToolCallCard, type ToolCallData } from './AssistantToolCallCard';

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
  createdAt: string;
}

export function AssistantMessage({ message }: { message: AssistantMessageData }) {
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
        {message.content && <AssistantMarkdown content={message.content} />}
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
