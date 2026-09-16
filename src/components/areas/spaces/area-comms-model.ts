import type { AreaRequestActionOption } from '@/modules/areas/requests-model';
import { relativeSince } from '@/modules/areas/area-time';
import type { AreaRequestDTO } from '@/modules/operations/area-requests-service';
import { AREA_REQUEST_OPEN_STATUSES } from '@/modules/operations/types';

/**
 * Pure view model of the communications space of an area (plan 7.5): which
 * conversation goes where, how a request reads at a glance and what the tabs
 * link to. No React and no I/O, so it is unit tested on its own.
 *
 * Every import that reaches the database is TYPE ONLY, so this module is safe
 * in the browser bundle: the decisions available on a request are computed on
 * the server (`@/modules/areas/requests-model`) and travel here as data.
 */

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const AREA_COMMS_TABS = ['chat', 'solicitudes', 'externos'] as const;

export type AreaCommsTab = (typeof AREA_COMMS_TABS)[number];

export const AREA_COMMS_TAB_LABELS: Readonly<Record<AreaCommsTab, string>> = {
  chat: 'Canal y expedientes',
  solicitudes: 'Solicitudes',
  externos: 'Clientes y proveedores',
};

/** `?tab=` of the space; anything unknown falls back to the internal chat. */
export function parseCommsTab(value: unknown): AreaCommsTab {
  return typeof value === 'string' && (AREA_COMMS_TABS as readonly string[]).includes(value)
    ? (value as AreaCommsTab)
    : 'chat';
}

/** Deep link of a tab (and, for the chat tab, of one conversation). */
export function commsTabHref(
  basePath: string,
  tab: AreaCommsTab,
  options: { channelId?: string | null } = {}
): string {
  const params = new URLSearchParams();
  if (tab !== 'chat') params.set('tab', tab);
  if (tab === 'chat' && options.channelId) params.set('canal', options.channelId);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** What the list needs from a channel of the internal chat. */
export interface AreaCommsChannel {
  id: string;
  name: string;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  /** Case id when the channel is the sales room of an expediente. */
  caseId: string | null;
}

export interface AreaCommsChannels {
  /** Channel of this area, when the person is a member of it. */
  areaChannel: AreaCommsChannel | null;
  /** Sales rooms the person belongs to, unread first. */
  caseRooms: AreaCommsChannel[];
  /** Sales rooms with something unread (before the visible limit is applied). */
  unreadCaseRooms: number;
  totalUnread: number;
}

/** Subset of `ChatChannelDTO` the grouping needs. */
export interface ChannelInput {
  id: string;
  type: string;
  name: string | null;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  areaKey: string | null;
  caseId: string | null;
}

const DEFAULT_CASE_ROOMS = 20;

function toChannel(input: ChannelInput, fallbackName: string): AreaCommsChannel {
  return {
    id: input.id,
    name: (input.name ?? '').trim() || fallbackName,
    unreadCount: Number.isFinite(input.unreadCount) ? Math.max(0, input.unreadCount) : 0,
    lastMessageAt: input.lastMessageAt,
    lastMessagePreview: input.lastMessagePreview,
    caseId: input.caseId,
  };
}

/**
 * Splits the person's channels into the channel of THIS area and their sales
 * rooms. Rooms are ordered by what needs reading first: unread ones (most
 * unread first) and then the most recent activity.
 */
export function groupAreaChannels(
  channels: readonly ChannelInput[],
  options: { areaKey: string; areaLabel?: string; limit?: number }
): AreaCommsChannels {
  const limit = Math.max(0, options.limit ?? DEFAULT_CASE_ROOMS);
  const areaInput = channels.find(
    (channel) => channel.type === 'area' && channel.areaKey === options.areaKey
  );
  const areaChannel = areaInput
    ? toChannel(areaInput, options.areaLabel ?? 'Canal del área')
    : null;

  const rooms = channels
    .filter((channel) => channel.type === 'case' && channel.caseId !== null)
    .map((channel) => toChannel(channel, 'Sala de venta'))
    .sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      const byActivity = Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt);
      return Number.isFinite(byActivity) && byActivity !== 0
        ? byActivity
        : a.id.localeCompare(b.id);
    });

  return {
    areaChannel,
    caseRooms: rooms.slice(0, limit),
    unreadCaseRooms: rooms.filter((room) => room.unreadCount > 0).length,
    totalUnread:
      (areaChannel?.unreadCount ?? 0) + rooms.reduce((sum, room) => sum + room.unreadCount, 0),
  };
}

/** "hace 3 min" for the last message of a conversation (the clock may be the server's ISO string). */
export function channelActivityLabel(
  channel: AreaCommsChannel,
  now: Date | number | string
): string {
  return relativeSince(channel.lastMessageAt, now);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** A request with the decisions its reader may take (computed on the server). */
export interface AreaRequestRow {
  request: AreaRequestDTO;
  actions: AreaRequestActionOption[];
  /** Why there is no button, in Spanish. */
  noActionsReason: string | null;
}

export type RequestTone = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak';

const OPEN = new Set<string>(AREA_REQUEST_OPEN_STATUSES);

export function isOpenRequestStatus(status: string): boolean {
  return OPEN.has(status);
}

const STATUS_TONE: Readonly<Record<string, RequestTone>> = {
  sent: 'default',
  acknowledged: 'info',
  accepted: 'info',
  blocked: 'warning',
  resolved: 'success',
  rejected: 'danger',
  cancelled: 'weak',
  expired: 'danger',
};

/** Colour of the status pill; an open request past its due date always reads as late. */
export function requestStatusTone(
  request: Pick<AreaRequestDTO, 'status' | 'overdue'>
): RequestTone {
  if (request.overdue && isOpenRequestStatus(request.status)) return 'danger';
  return STATUS_TONE[request.status] ?? 'default';
}

export interface RequestsSummary {
  incoming: number;
  incomingOverdue: number;
  outgoing: number;
  outgoingOverdue: number;
  /** Open requests that hold a delivery (either direction). */
  blocking: number;
}

/** Counters of the "Solicitudes" tab and of the list badge. */
export function summarizeRequests(
  incoming: readonly AreaRequestRow[],
  outgoing: readonly AreaRequestRow[]
): RequestsSummary {
  const overdue = (rows: readonly AreaRequestRow[]) =>
    rows.filter((row) => row.request.overdue && isOpenRequestStatus(row.request.status)).length;
  const blocking = [...incoming, ...outgoing].filter(
    (row) => row.request.blocksDelivery && isOpenRequestStatus(row.request.status)
  ).length;
  return {
    incoming: incoming.length,
    incomingOverdue: overdue(incoming),
    outgoing: outgoing.length,
    outgoingOverdue: overdue(outgoing),
    blocking,
  };
}

/** One-line description of a request: kind, areas and the case it belongs to. */
export function requestMetaLine(request: AreaRequestDTO): string {
  return [
    request.kindLabel,
    `${request.fromAreaLabel} → ${request.toAreaLabel}`,
    request.caseNumber,
    request.customerName,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}
