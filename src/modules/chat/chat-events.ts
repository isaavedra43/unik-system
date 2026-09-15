/**
 * Chat SSE event types and DTOs.
 *
 * These types are shared between the server (SSE producer) and the client
 * (EventSource consumer). They are intentionally serializable (no Date, no
 * BigInt — everything is string-encoded).
 */

export interface ChatAttachmentDTO {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
}

export interface ChatReactionDTO {
  emoji: string;
  userId: string;
  userName: string;
}

interface ChatLocationDTO {
  latitude: number;
  longitude: number;
  label: string | null;
}

interface ChatPollOptionDTO {
  id: string;
  text: string;
  voteCount: number;
  hasVoted: boolean;
}

export interface ChatPollDTO {
  id: string;
  question: string;
  isMulti: boolean;
  isAnonymous: boolean;
  closesAt: string | null;
  totalVotes: number;
  options: ChatPollOptionDTO[];
  userVotedOptionIds: string[];
}

export interface ChatEventDTO {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  createdBy: string;
  rsvpCounts: { yes: number; no: number; maybe: number };
  userRsvp: string | null;
}

// =====================================================
// Channel kinds and AI (bot) messages
// =====================================================

/**
 * `dm`/`group` are created by people from the chat UI; `area` (one per
 * operational area) and `case` (one sales room per operational case) are
 * created only by the operations layer through `createAreaChannel` /
 * `createCaseRoom`, and their members are kept in sync by that layer.
 */
export const CHAT_CHANNEL_TYPES = ['dm', 'group', 'area', 'case'] as const;
export type ChatChannelType = (typeof CHAT_CHANNEL_TYPES)[number];

/** Channel types whose membership is managed by the operations layer. */
export const OPERATIONS_CHANNEL_TYPES: readonly string[] = ['area', 'case'];

export function isOperationsChannelType(type: string | null | undefined): boolean {
  return typeof type === 'string' && OPERATIONS_CHANNEL_TYPES.includes(type);
}

/** Structured metadata attached to a message posted by an AI (bot) user. */
export type ChatMessageMeta = { kind?: string } & Record<string, unknown>;

/**
 * `meta.kind` values of rule-based (template) posts. The agents layer notifies
 * the responsible person directly, so these posts never fan out chat
 * notifications. Free-form lines written by the model use `agent_reply`
 * (or any other kind) and notify like a normal message.
 */
export const CHAT_BOT_TEMPLATE_KINDS: readonly string[] = [
  'agent_request',
  'agent_proposal',
  'agent_notice',
  'agent_update',
  'agent_timeline',
];

export function isBotTemplateMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const record = meta as Record<string, unknown>;
  if (record.template === true) return true;
  return typeof record.kind === 'string' && CHAT_BOT_TEMPLATE_KINDS.includes(record.kind);
}

export const AGENT_REQUEST_QUICK_ACTIONS = ['accept', 'block', 'open_case'] as const;
export type AgentRequestQuickAction = (typeof AGENT_REQUEST_QUICK_ACTIONS)[number];

export interface ChatAgentRequestMeta {
  kind: 'agent_request';
  requestId: string;
  caseId: string | null;
  areaKey: string | null;
  quickActions: AgentRequestQuickAction[];
  /** When present, only these users see Aceptar/Bloquear (the server still validates). */
  actorUserIds: string[] | null;
  /** AreaRequest status when the post was written; kept current by the room stream and a live read. */
  status: string | null;
  /** Id of the room card this post copies (the copy in an area channel informs; it has no actions). */
  copyOf: string | null;
}

export interface ChatAgentProposalMeta {
  kind: 'agent_proposal';
  proposalId: string;
  caseId: string | null;
  toolName: string | null;
  summary: string | null;
  effect: string | null;
  expiresAt: string | null;
  args: unknown;
  status: string | null;
  /** Responsible and backup who may decide it (others see a read-only card; approvers by permission use Mi trabajo). */
  approverUserIds: string[] | null;
  /** The tool needs two distinct signatures. */
  requiresSecondApproval: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Typed view of an `agent_request` meta, or null when the shape is not usable. */
export function parseAgentRequestMeta(meta: unknown): ChatAgentRequestMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const requestId = asString(record.requestId);
  if (record.kind !== 'agent_request' || !requestId) return null;
  const listed = asStringList(record.quickActions);
  const quickActions = (listed ?? [...AGENT_REQUEST_QUICK_ACTIONS]).filter(
    (action): action is AgentRequestQuickAction =>
      (AGENT_REQUEST_QUICK_ACTIONS as readonly string[]).includes(action)
  );
  return {
    kind: 'agent_request',
    requestId,
    caseId: asString(record.caseId),
    areaKey: asString(record.areaKey),
    quickActions: [...new Set(quickActions)],
    actorUserIds: asStringList(record.actorUserIds),
    status: asString(record.status),
    copyOf: asString(record.copyOf),
  };
}

/**
 * Status carried by an `agent_update` post of an area request (`{requestId, status}`), or null.
 * The room stream uses it to refresh the status of the request's earlier cards.
 */
export function agentRequestStatusUpdate(message: Pick<ChatMessageDTO, 'meta'>): { requestId: string; status: string } | null {
  const meta = message.meta;
  if (!meta || meta.kind !== 'agent_update') return null;
  const requestId = asString(meta.requestId);
  const status = asString(meta.status);
  return requestId && status ? { requestId, status } : null;
}

/** Messages with the status of every `agent_request` card of that request replaced (same array when nothing changes). Pure. */
export function applyAgentRequestStatus<T extends Pick<ChatMessageDTO, 'meta'>>(
  messages: T[],
  update: { requestId: string; status: string }
): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const meta = message.meta;
    if (!meta || meta.kind !== 'agent_request' || meta.requestId !== update.requestId || meta.status === update.status) {
      return message;
    }
    changed = true;
    return { ...message, meta: { ...meta, status: update.status } };
  });
  return changed ? next : messages;
}

/** Typed view of an `agent_proposal` meta, or null when the shape is not usable. */
export function parseAgentProposalMeta(meta: unknown): ChatAgentProposalMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const proposalId = asString(record.proposalId);
  if (record.kind !== 'agent_proposal' || !proposalId) return null;
  return {
    kind: 'agent_proposal',
    proposalId,
    caseId: asString(record.caseId),
    toolName: asString(record.toolName),
    summary: asString(record.summary),
    effect: asString(record.effect),
    expiresAt: asString(record.expiresAt),
    args: record.args,
    status: asString(record.status),
    approverUserIds: asStringList(record.approverUserIds),
    requiresSecondApproval: record.requiresSecondApproval === true,
  };
}

export interface ChatMessageDTO {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  /** The sender is an AI (bot) user of the agents layer. */
  senderIsBot: boolean;
  /** Structured metadata (only bot posts carry it). */
  meta: ChatMessageMeta | null;
  content: string | null;
  replyToId: string | null;
  replyToPreview: string | null;
  replyToSenderName: string | null;
  forwardedFromId: string | null;
  forwardedBy: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  priority: 'normal' | 'urgent';
  threadId: string | null;
  threadRootMessageId: string | null;
  createdAt: string;
  attachments: ChatAttachmentDTO[];
  reactions: ChatReactionDTO[];
  readBy: string[];
  mentions: string[];
  location: ChatLocationDTO | null;
  poll: ChatPollDTO | null;
  event: ChatEventDTO | null;
  isPinned: boolean;
  isBookmarked: boolean;
}

export interface ChatChannelDTO {
  id: string;
  type: string;
  name: string | null;
  avatarPath: string | null;
  createdBy: string;
  lastMessageAt: string;
  createdAt: string;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageSenderName: string | null;
  members: ChatChannelMemberDTO[];
  /** Area key when `type === 'area'` (Area.chatChannelId points to this channel). */
  areaKey: string | null;
  /** OperationalCase id when `type === 'case'` (OperationalCase.chatChannelId points here). */
  caseId: string | null;
}

export interface ChatChannelMemberDTO {
  userId: string;
  name: string;
  username: string;
  role: string;
  status: string;
  lastSeenAt: string;
  isBot: boolean;
}

export interface ChatCallDTO {
  id: string;
  channelId: string;
  callerId: string;
  callerName: string;
  type: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'declined';
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  participants: {
    userId: string;
    name: string;
    acceptedAt: string | null;
    declinedAt: string | null;
  }[];
}

export type ChatStreamEvent =
  | { type: 'message'; data: ChatMessageDTO }
  | { type: 'edit'; data: { messageId: string; content: string; editedAt: string } }
  | { type: 'delete'; data: { messageId: string } }
  | {
      type: 'reaction';
      data: {
        messageId: string;
        userId: string;
        userName: string;
        emoji: string;
        action: 'add' | 'remove';
      };
    }
  | { type: 'read'; data: { channelId: string; userId: string; lastReadAt: string } }
  | { type: 'read_update'; data: { channelId: string; messageIds: string[]; userId: string } }
  | { type: 'presence'; data: { userId: string; status: string; lastSeenAt: string } }
  | {
      type: 'typing';
      data: {
        channelId: string;
        userId: string;
        userName: string;
        isTyping: boolean;
        preview?: string;
      };
    }
  | { type: 'mention'; data: { messageId: string; channelId: string; userId: string } }
  | { type: 'poll_vote'; data: { pollId: string; optionId: string; userId: string } }
  | { type: 'event_rsvp'; data: { eventId: string; userId: string; status: string } }
  | { type: 'pin'; data: { channelId: string; messageId: string; action: 'pin' | 'unpin' } }
  | { type: 'call_invite'; data: ChatCallDTO }
  | { type: 'call_accept'; data: { callId: string; userId: string } }
  | { type: 'call_decline'; data: { callId: string; userId: string } }
  | { type: 'call_end'; data: { callId: string; status: string } }
  | {
      type: 'webrtc_signal';
      data: { callId: string; fromUserId: string; signalType: string; signal: string };
    }
  | { type: 'heartbeat'; data: { t: number } }
  | { type: 'error'; data: { message: string } };

export interface ChatInboxItem {
  channelId: string;
  type: string;
  name: string | null;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string;
  lastMessageSenderName: string | null;
  otherUserId: string | null;
  otherUserName: string | null;
  otherUserStatus: string | null;
}
