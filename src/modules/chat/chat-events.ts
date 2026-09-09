/**
 * Chat SSE event types and DTOs.
 *
 * These types are shared between the server (SSE producer) and the client
 * (EventSource consumer). They are intentionally serializable (no Date, no
 * BigInt — everything is string-encoded).
 */

export interface ChatUserDTO {
  id: string;
  name: string;
  username: string;
  email: string | null;
}

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

export interface ChatMessageDTO {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string | null;
  replyToId: string | null;
  replyToPreview: string | null;
  replyToSenderName: string | null;
  forwardedFromId: string | null;
  forwardedBy: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: ChatAttachmentDTO[];
  reactions: ChatReactionDTO[];
  readBy: string[];
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
}

export interface ChatChannelMemberDTO {
  userId: string;
  name: string;
  username: string;
  role: string;
  status: string;
  lastSeenAt: string;
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
  | { type: 'presence'; data: { userId: string; status: string; lastSeenAt: string } }
  | {
      type: 'typing';
      data: { channelId: string; userId: string; userName: string; isTyping: boolean };
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
