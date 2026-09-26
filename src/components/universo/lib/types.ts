import type { MessageFeedbackData, TurnMeta } from '@/components/copilot/copilot-types';

/**
 * UNIVERSO front — shared data shapes. They mirror the server DTOs of
 * /app/assistant/api/* (conversations, messages, proposals, agents).
 */

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ToolRecord {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
}

export interface AttachmentInfo {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ArtifactInfo {
  artifactId: string;
  type: 'pdf' | 'xlsx' | 'docx' | 'csv' | 'table' | 'chart' | 'image';
  title: string;
  filename?: string;
  downloadUrl?: string;
  inlineRender?: boolean;
  rowCount?: number;
  sizeBytes?: number;
  pageCount?: number;
  chartType?: string;
  shared?: boolean;
  storageObjectId?: string;
  mimeType?: string;
  quoteId?: string;
  version?: number;
  supersededBy?: string;
  createdAt?: string;
}

export interface MessageData {
  id: string;
  role: ChatRole;
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallRecords?: ToolRecord[];
  attachments?: AttachmentInfo[];
  artifacts?: ArtifactInfo[];
  meta?: TurnMeta | null;
  feedback?: MessageFeedbackData | null;
  createdAt: string;
}

export interface ProposalInfo {
  id: string;
  toolName: string;
  summary: string;
  effect: string;
  expiresAt: string;
  args?: unknown;
  recipient?: string | null;
  status?: string;
  result?: unknown;
  error?: string | null;
}

export interface ProposalExecution {
  success?: boolean;
  error?: string;
  uncertain?: boolean;
  result?: unknown;
}

/** A tool call while the answer streams (before it is persisted). */
export interface LiveToolCall {
  key: string;
  name: string;
  args?: unknown;
  success?: boolean;
  durationMs?: number;
  startedAt: number;
}

export type AgentStatus = 'idle' | 'working' | 'offline';

export interface AgentInfo {
  id: string;
  name: string;
  /** 'principal' = the built-in coordinator (always first, "Jefe"). */
  kind: 'principal' | 'specialist';
  purpose?: string | null;
  color?: number;
  icon?: string;
  status?: AgentStatus;
  sortOrder?: number;
}

/** Server DTO (src/modules/agents/agent-service.ts `AgentRecord`). */
export interface AgentRecordDTO {
  id: string;
  kind: string;
  name: string;
  purpose: string | null;
  icon: string | null;
  color: string | null;
  status: string;
  sortOrder: number;
}

export interface ConversationItem {
  id: string;
  title: string | null;
  isStarred: boolean;
  /** Agent that owns the thread (null = principal / legacy). */
  agentId?: string | null;
  lastMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceTab = 'browser' | 'computer' | 'team' | 'files';

/** A background task delegated to the team (SSE `agent.task` on user:{id}). */
export interface TeamTask {
  taskId: string;
  status: string;
  title: string;
  agentId?: string | null;
  conversationId?: string | null;
  reportPreview?: string | null;
  durationMs?: number | null;
  updatedAt: number;
}
