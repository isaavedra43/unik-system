// Hoja de comunicaciones del área (sólo tokens). Next permite CSS global desde un componente.
import '@/styles/operations/area-comms.css';
import { prisma } from '@/lib/prisma';
import type { CommAccountDTO, InboxUserInfo } from '@/components/inbox/inbox-types';
import { ensureAreaChannel } from '@/modules/agents/chat-bridge';
import { areaHref, type AreaMeta } from '@/modules/areas/area-registry';
import {
  areaRequestActions,
  noDecisionReason,
  type AreaRequestActor,
} from '@/modules/areas/requests-model';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { listUserChannels } from '@/modules/chat/chat-service';
import { listAccountsForUser } from '@/modules/comms/comms-accounts-service';
import { listAreaRequests, type AreaRequestDTO } from '@/modules/operations/area-requests-service';
import { AreaCommsClient } from './AreaCommsClient';
import { groupAreaChannels, parseCommsTab, type AreaRequestRow } from './area-comms-model';

/**
 * Communications space of an area (plan 7.5). Server Component.
 *
 * Before rendering anything it makes sure the area HAS its channel and that its
 * members are in sync (`ensureAreaChannel`, idempotent): a person who just got
 * the permissions of the area finds the conversation already there.
 *
 * Access: the page and the layout already require the area's view permission;
 * every read here applies its own rule again — the requests through the core
 * service (`listAreaRequests`), the conversations through the chat membership
 * of the person (`listUserChannels` only returns channels they belong to) and
 * the external accounts through the inbox rule (`listAccountsForUser`).
 */

export interface AreaCommsPageProps {
  area: AreaMeta;
  user: CurrentUser;
  /** Server time of the render, so relative labels match on hydration. */
  nowIso: string;
  /** Flattened search params of the page (`tab`, `canal`). */
  searchParams: Record<string, string>;
}

const REQUEST_LIMIT = 50;
const CASE_ROOM_LIMIT = 20;

/** Responsible, backup or lead of the area (the second half of the core rule). */
async function isAreaResponsible(userId: string, areaKey: string): Promise<boolean> {
  const area = await prisma.area.findUnique({
    where: { key: areaKey },
    select: { leadUserId: true, responsibleArea: true },
  });
  if (area?.leadUserId === userId) return true;
  const responsible = await prisma.responsible.findUnique({
    where: { area: area?.responsibleArea || areaKey },
    select: { userId: true, backupUserId: true, active: true },
  });
  return Boolean(
    responsible?.active && (responsible.userId === userId || responsible.backupUserId === userId)
  );
}

export async function AreaCommsPage({ area, user, nowIso, searchParams }: AreaCommsPageProps) {
  const now = new Date(nowIso);
  const tab = parseCommsTab(searchParams.tab);
  const basePath = areaHref(area.key, 'comunicaciones');

  const canChat = hasPermission(user, 'chat.use');
  const canInbox = hasPermission(user, 'inbox.use') || hasPermission(user, 'inbox.admin');
  const canUseAssistant = hasPermission(user, 'assistant.use');

  let channelNote: string | null = canChat
    ? null
    : 'No tienes acceso al chat interno; pide el permiso a Administración.';

  if (canChat) {
    try {
      /*
       * `ensureAreaChannel` is a WRITE path (it resolves the people of the area
       * crossing roles → permissions and then rewrites the membership), and it
       * used to run on EVERY navigation to this page, for the six areas. It now
       * runs only when there is something to fix for the person in front of us:
       * the channel does not exist yet, or they are not in it (they just got the
       * permissions of the area). Removing somebody who LOST the permissions is
       * a reaction to that change, not to a page view.
       */
      const linked = await prisma.area.findUnique({
        where: { key: area.key },
        select: { chatChannelId: true },
      });
      const alreadyMember = linked?.chatChannelId
        ? (await prisma.internalChatMember.count({
            where: { channelId: linked.chatChannelId, userId: user.id, leftAt: null },
          })) > 0
        : false;
      if (!alreadyMember) await ensureAreaChannel(area.key);
    } catch (err) {
      channelNote = `Todavía no hay canal de ${area.label}: pide a Administración que termine el arranque de operaciones.`;
      console.warn(
        JSON.stringify({
          component: 'area-comms',
          event: 'ensure_area_channel_failed',
          areaKey: area.key,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  async function loadRequests(direction: 'in' | 'out'): Promise<AreaRequestDTO[] | null> {
    try {
      const page = await listAreaRequests(
        user,
        area.key,
        { direction, scope: 'open', limit: REQUEST_LIMIT },
        { now }
      );
      return page.items;
    } catch {
      return null;
    }
  }

  async function loadAccounts(): Promise<CommAccountDTO[]> {
    if (!canInbox) return [];
    try {
      const teamKeys = new Set(area.comms.inboxTeamKeys);
      const accounts = await listAccountsForUser(user);
      return accounts.filter((account) => account.teamKeys.some((key) => teamKeys.has(key)));
    } catch {
      return [];
    }
  }

  const [channelList, incomingItems, outgoingItems, accounts, areaResponsible] = await Promise.all([
    canChat ? listUserChannels(user.id) : Promise.resolve([]),
    loadRequests('in'),
    loadRequests('out'),
    loadAccounts(),
    isAreaResponsible(user.id, area.key),
  ]);

  const actor: AreaRequestActor = {
    userId: user.id,
    canManage: hasPermission(user, 'operations.manage') || hasPermission(user, 'operations.admin'),
    areaResponsible,
  };

  const toRows = (items: AreaRequestDTO[] | null, direction: 'in' | 'out'): AreaRequestRow[] =>
    (items ?? []).map((request) => ({
      request,
      actions: areaRequestActions(request, actor, { direction }),
      noActionsReason: noDecisionReason(request, actor, { direction }),
    }));

  const channels = groupAreaChannels(channelList, {
    areaKey: area.key,
    areaLabel: area.label,
    limit: CASE_ROOM_LIMIT,
  });

  const known = new Set(
    [channels.areaChannel?.id, ...channels.caseRooms.map((room) => room.id)].filter(
      (id): id is string => Boolean(id)
    )
  );
  const requested = searchParams.canal;
  const initialChannelId =
    requested && known.has(requested)
      ? requested
      : (channels.areaChannel?.id ?? channels.caseRooms[0]?.id ?? null);

  const inboxUser: InboxUserInfo | null = canInbox
    ? {
        id: user.id,
        name: user.name,
        roleKeys: user.roleKeys,
        canAssign: hasPermission(user, 'inbox.assign') || hasPermission(user, 'inbox.admin'),
        isAdmin: hasPermission(user, 'inbox.admin'),
      }
    : null;

  return (
    <AreaCommsClient
      area={{ key: area.key, label: area.label }}
      basePath={basePath}
      tab={tab}
      user={user}
      channels={channels}
      channelNote={channelNote}
      initialChannelId={initialChannelId}
      incoming={toRows(incomingItems, 'in')}
      outgoing={toRows(outgoingItems, 'out')}
      requestsNote={
        incomingItems === null || outgoingItems === null
          ? 'No pudimos leer todas las solicitudes del área; vuelve a intentarlo en unos segundos.'
          : null
      }
      inboxUser={inboxUser}
      accounts={accounts}
      teamKeys={[...new Set(accounts.flatMap((account) => account.teamKeys))]}
      inboxTeamKeys={area.comms.inboxTeamKeys}
      canChat={canChat}
      canUseAssistant={canUseAssistant}
      nowIso={nowIso}
    />
  );
}
