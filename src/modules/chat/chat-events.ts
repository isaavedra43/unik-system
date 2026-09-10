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
}

export interface ChatChannelMemberDTO {
  userId: string;
  name: string;
  username: string;
  role: string;
  status: string;
  lastSeenAt: string;
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
