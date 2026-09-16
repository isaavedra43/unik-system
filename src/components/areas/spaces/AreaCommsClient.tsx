'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { TabNav } from '@/components/ui/composite';
import { Alert, Button } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import type { CommAccountDTO, InboxUserInfo } from '@/components/inbox/inbox-types';
import { AREA_WORK_REALTIME_TYPES } from '@/modules/areas/area-work-row';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AreaCommsList } from './AreaCommsList';
import { AreaRequestsPanel } from './AreaRequestsPanel';
import {
  AREA_COMMS_TAB_LABELS,
  commsTabHref,
  summarizeRequests,
  type AreaCommsChannels,
  type AreaCommsTab,
  type AreaRequestRow,
} from './area-comms-model';

/*
 * El chat interno completo y la bandeja externa son el bulto del paquete de
 * `/app/areas/[areaKey]/[space]` (496 kB de first-load, el más pesado del
 * repositorio) y Next los metía en la entrada de cliente de TODA la ruta: abrir
 * el panel de Contabilidad descargaba el chat y la bandeja enteros. Con
 * `next/dynamic` cada uno viaja en su propio trozo y sólo cuando su pestaña se
 * abre. Se renderizan en el servidor igual que antes (no se apaga el SSR).
 */
const ChatConversation = dynamic(() =>
  import('@/components/chat/ChatConversation').then((mod) => mod.ChatConversation)
);
const ChatCopilotPanel = dynamic(() =>
  import('@/components/chat/ChatCopilotPanel').then((mod) => mod.ChatCopilotPanel)
);
const InboxEmbedded = dynamic(() => import('./InboxEmbedded').then((mod) => mod.InboxEmbedded));

/**
 * Communications space of an area (plan 7.5). Three tabs, one URL each:
 * - `chat`: the channel of the area and the sales rooms of the person, with the
 *   internal-chat conversation and its copilot beside it;
 * - `solicitudes`: what other areas asked for and what this area is waiting for;
 * - `externos`: the shared inbox restricted to the accounts of the area.
 *
 * Everything shown here is an existing component (ChatConversation,
 * ChatCopilotPanel, the inbox list and thread); this file only decides what
 * goes where and keeps the area's realtime chip honest.
 */

export interface AreaCommsClientProps {
  area: { key: string; label: string };
  basePath: string;
  tab: AreaCommsTab;
  user: CurrentUser;
  channels: AreaCommsChannels;
  /** Why there is no area channel, in Spanish. */
  channelNote: string | null;
  initialChannelId: string | null;
  incoming: AreaRequestRow[];
  outgoing: AreaRequestRow[];
  requestsNote: string | null;
  /** null when the person may not use the external inbox. */
  inboxUser: InboxUserInfo | null;
  accounts: CommAccountDTO[];
  teamKeys: string[];
  /** Roles `equipo_<área>` que el registro declara: lo que hay que marcar en un canal. */
  inboxTeamKeys: readonly string[];
  canChat: boolean;
  canUseAssistant: boolean;
  nowIso: string;
}

type MobileView = 'list' | 'main' | 'ai';

export function AreaCommsClient({
  area,
  basePath,
  tab,
  user,
  channels,
  channelNote,
  initialChannelId,
  incoming,
  outgoing,
  requestsNote,
  inboxUser,
  accounts,
  teamKeys,
  inboxTeamKeys,
  canChat,
  canUseAssistant,
  nowIso,
}: AreaCommsClientProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [selectedId, setSelectedId] = useState<string | null>(initialChannelId);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number } | null>(null);
  const [chatActivityAt, setChatActivityAt] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>(tab === 'chat' ? 'list' : 'main');

  // A new server render (another tab, a decision, "Actualizar") wins over the local pick.
  useEffect(() => {
    setSelectedId(initialChannelId);
  }, [initialChannelId]);

  useOperationsRealtime(
    [`area:${area.key}`],
    AREA_WORK_REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  const refresh = useCallback(() => {
    setPendingEvents(0);
    router.refresh();
  }, [router]);

  const summary = summarizeRequests(incoming, outgoing);
  const tabs = [
    {
      id: 'chat' as const,
      label: AREA_COMMS_TAB_LABELS.chat,
      href: commsTabHref(basePath, 'chat'),
    },
    {
      id: 'solicitudes' as const,
      label:
        summary.incoming > 0
          ? `${AREA_COMMS_TAB_LABELS.solicitudes} (${summary.incoming})`
          : AREA_COMMS_TAB_LABELS.solicitudes,
      href: commsTabHref(basePath, 'solicitudes'),
    },
    ...(inboxUser
      ? [
          {
            id: 'externos' as const,
            label: AREA_COMMS_TAB_LABELS.externos,
            href: commsTabHref(basePath, 'externos'),
          },
        ]
      : []),
  ];

  const showRail = !isMobile || mobileView === 'list';
  const showMain = !isMobile || mobileView === 'main';
  const showAside = canUseAssistant && (isMobile ? mobileView === 'ai' : true);

  const selectChannel = (channelId: string) => {
    setSelectedId(channelId);
    setChatActivityAt(null);
    if (isMobile) setMobileView('main');
  };

  const rail = (
    <div className="area-comms-rail">
      <AreaCommsList
        areaLabel={area.label}
        channels={channels}
        selectedId={selectedId}
        onSelect={selectChannel}
        activeTab={tab}
        requests={{
          incoming: summary.incoming,
          incomingOverdue: summary.incomingOverdue,
          outgoing: summary.outgoing,
        }}
        requestsHref={commsTabHref(basePath, 'solicitudes')}
        chatHref={commsTabHref(basePath, 'chat')}
        externalHref={inboxUser ? commsTabHref(basePath, 'externos') : null}
        externalAccounts={accounts.length}
        note={channelNote}
        nowIso={nowIso}
        fullWidth={isMobile}
      />
    </div>
  );

  return (
    <div className="area-comms-shell">
      {/*
        El carril de la izquierda ya lleva los mismos tres destinos CON sus
        conteos y marca el activo, así que en escritorio estas pestañas eran
        una segunda copia de la misma decisión. En teléfono el carril sólo se
        ve en la vista de lista, así que ahí siguen siendo la única forma de
        cambiar de pestaña (`.area-comms-tabs` las oculta en ≥769 px).
      */}
      <div className="area-comms-tabs">
        <TabNav activeId={tab} tabs={tabs} />
      </div>

      <div className="area-comms-toolbar">
        <span>
          Canal de {area.label}, salas de las ventas en las que participas y solicitudes entre
          áreas.
        </span>
        {pendingEvents > 0 ? (
          <Button variant="secondary" size="sm" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {pendingEvents === 1
              ? 'Hay 1 movimiento nuevo · Actualizar'
              : `Hay ${pendingEvents} movimientos nuevos · Actualizar`}
          </Button>
        ) : null}
      </div>

      <div className="area-comms-body">
        {tab === 'externos' ? (
          inboxUser ? (
            <InboxEmbedded
              user={inboxUser}
              accounts={accounts}
              areaKey={area.key}
              areaLabel={area.label}
              teamKeys={teamKeys}
              inboxTeamKeys={inboxTeamKeys}
              isMobile={isMobile}
            />
          ) : (
            <div className="area-comms-placeholder">
              <p className="area-comms-placeholder-title">Bandeja externa no disponible</p>
              <p>
                No tienes el permiso de bandeja. Pídeselo a Administración si necesitas atender a
                los clientes y proveedores de {area.label}.
              </p>
            </div>
          )
        ) : (
          <>
            {showRail ? rail : null}

            {showMain ? (
              <div className="area-comms-main chat-page-main">
                {tab === 'solicitudes' ? (
                  <AreaRequestsPanel
                    areaLabel={area.label}
                    incoming={incoming}
                    outgoing={outgoing}
                    note={requestsNote}
                    nowIso={nowIso}
                    onDecided={() => setPendingEvents(0)}
                  />
                ) : !canChat ? (
                  <div className="area-comms-placeholder">
                    <p className="area-comms-placeholder-title">Chat interno no disponible</p>
                    <p>
                      No tienes acceso al chat interno; pide el permiso a Administración. Las
                      solicitudes del área siguen disponibles en su pestaña.
                    </p>
                  </div>
                ) : selectedId ? (
                  <ChatConversation
                    key={selectedId}
                    channelId={selectedId}
                    user={user}
                    onRefresh={refresh}
                    onBack={isMobile ? () => setMobileView('list') : undefined}
                    aiOpen={canUseAssistant && !isMobile}
                    onToggleAi={canUseAssistant && isMobile ? () => setMobileView('ai') : undefined}
                    insertRequest={insertRequest}
                    onForeignMessage={(createdAt) => setChatActivityAt(createdAt)}
                  />
                ) : (
                  <div className="area-comms-placeholder">
                    <p className="area-comms-placeholder-title">Selecciona una conversación</p>
                    <p>
                      {channelNote ??
                        `Aquí hablan las personas de ${area.label} con su IA coordinadora, y cada venta tiene su propia sala.`}
                    </p>
                  </div>
                )}
              </div>
            ) : null}

            {tab === 'chat' && canChat && selectedId && showAside ? (
              <aside className="area-comms-aside" aria-label={`Copiloto de ${area.label}`}>
                <ChatCopilotPanel
                  key={selectedId}
                  channelId={selectedId}
                  user={{ id: user.id, name: user.name }}
                  activityAt={chatActivityAt}
                  onInsertDraft={(text) => {
                    setInsertRequest({ text, nonce: Date.now() });
                    if (isMobile) setMobileView('main');
                  }}
                  onAfterTurn={refresh}
                  onBack={isMobile ? () => setMobileView('main') : undefined}
                />
              </aside>
            ) : null}
          </>
        )}
      </div>

      {tab === 'solicitudes' && requestsNote ? (
        <Alert variant="warning">{requestsNote}</Alert>
      ) : null}
    </div>
  );
}
