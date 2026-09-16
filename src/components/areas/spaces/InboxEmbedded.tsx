'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConversationList } from '@/components/inbox/ConversationList';
import { ConversationView } from '@/components/inbox/ConversationView';
import { CopilotPanel } from '@/components/inbox/copilot/CopilotPanel';
import type { ComposerAttachment } from '@/components/inbox/MessageComposer';
import { useInboxRealtime } from '@/components/inbox/useInboxRealtime';
import { takeCommsDraft } from '@/modules/areas/comms-draft';
import {
  apiJson,
  type CommAccountDTO,
  type CommConversationDTO,
  type InboxFilters,
  type InboxUserInfo,
  type InboxUserOption,
  type RealtimeEnvelope,
} from '@/components/inbox/inbox-types';

/**
 * External conversations of an area (plan 7.5): the shared inbox restricted to
 * the accounts of this area (`CommAccount.teamKeys` ∩ `inboxTeamKeys`), with
 * the same list, the same thread and the same copilot as `/app/inbox`.
 *
 * Nothing of the inbox is reimplemented: the list, the thread, the composer and
 * the copilot are the inbox components; this file only presets the accounts and
 * hides the two controls that do not belong in an area (choosing another
 * channel and starting a conversation from scratch).
 */

export interface InboxEmbeddedProps {
  user: InboxUserInfo;
  /** Accounts of the area; empty means the area has no external channel yet. */
  accounts: CommAccountDTO[];
  /** Key of the area: identifies the draft another surface left for this inbox. */
  areaKey: string;
  areaLabel: string;
  /** Realtime team channels of those accounts. */
  teamKeys: string[];
  /**
   * Roles `equipo_<área>` que el registro declara (`AreaMeta.comms.inboxTeamKeys`).
   * Sólo se usan para DECIR qué hay que marcar cuando el área no tiene canales:
   * el filtro de verdad ya lo aplicó el servidor.
   */
  inboxTeamKeys: readonly string[];
  /** ≤768: one column at a time. */
  isMobile: boolean;
}

type MobileView = 'list' | 'conversation' | 'ai';

const DEFAULT_FILTERS: InboxFilters = {
  accountId: '',
  status: 'open',
  assigned: 'all',
  search: '',
};

const PAGE_SIZE = 30;

export function InboxEmbedded({
  user,
  accounts,
  areaKey,
  areaLabel,
  teamKeys,
  inboxTeamKeys,
  isMobile,
}: InboxEmbeddedProps) {
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_FILTERS);
  const [conversations, setConversations] = useState<CommConversationDTO[]>([]);
  const [users, setUsers] = useState<InboxUserOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** Borrador que otra superficie del área dejó para esta bandeja (Radar de cierre). */
  const [handoff, setHandoff] = useState<string | null>(null);
  const [attachSeed, setAttachSeed] = useState<ComposerAttachment | null>(null);
  const [threadVersion, setThreadVersion] = useState(0);
  const [aiOpen, setAiOpen] = useState(true);
  const [mobileView, setMobileView] = useState<MobileView>('list');

  const accountIds = useMemo(() => accounts.map((account) => account.id), [accounts]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const body = useCallback(
    (current: InboxFilters, cursor?: string | null) => ({
      accountIds,
      status: current.status,
      ...(current.assigned === 'all' ? {} : { assigned: current.assigned }),
      ...(current.search.trim() ? { search: current.search.trim() } : {}),
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    }),
    [accountIds]
  );

  const load = useCallback(
    async (current: InboxFilters, options: { silent?: boolean } = {}) => {
      if (accountIds.length === 0) {
        setConversations([]);
        setLoading(false);
        return;
      }
      if (!options.silent) setLoading(true);
      try {
        const data = await apiJson<{ items: CommConversationDTO[]; nextCursor: string | null }>(
          '/app/inbox/api/conversations',
          { method: 'POST', body: JSON.stringify(body(current)) }
        );
        setConversations(data.items);
        setNextCursor(data.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar la bandeja del área');
      } finally {
        setLoading(false);
      }
    },
    [accountIds.length, body]
  );

  useEffect(() => {
    const handle = setTimeout(() => void load(filters), filters.search ? 300 : 0);
    return () => clearTimeout(handle);
  }, [filters, load]);

  useEffect(() => {
    apiJson<{ users: InboxUserOption[] }>('/app/inbox/api/users')
      .then((data) => setUsers(data.users))
      .catch(() => setUsers([]));
  }, []);

  /**
   * Cierra el traspaso «señal → borrador → mensaje» (plan 7.6): el copiloto del
   * Radar de cierre dejó el texto en la pestaña y aquí cae en el redactor. Se
   * consume UNA vez; si todavía no hay conversación abierta, espera a que la
   * persona elija con quién hablar.
   */
  useEffect(() => {
    const stashed = takeCommsDraft(areaKey);
    if (stashed) setHandoff(stashed.text);
  }, [areaKey]);

  useEffect(() => {
    if (!handoff || !selectedId) return;
    setDraft(handoff);
    setHandoff(null);
    if (isMobile) setMobileView('conversation');
    toast.success('Borrador listo en el redactor');
  }, [handoff, selectedId, isMobile]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const data = await apiJson<{ items: CommConversationDTO[]; nextCursor: string | null }>(
        '/app/inbox/api/conversations',
        { method: 'POST', body: JSON.stringify(body(filtersRef.current, nextCursor)) }
      );
      setConversations((prev) => {
        const ids = new Set(prev.map((conversation) => conversation.id));
        return [...prev, ...data.items.filter((conversation) => !ids.has(conversation.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cargar más');
    }
  }, [body, nextCursor]);

  const refreshConversation = useCallback(
    async (id: string) => {
      try {
        const data = await apiJson<{ conversation: CommConversationDTO }>(
          `/app/inbox/api/conversations/${id}`
        );
        setConversations((prev) => {
          const exists = prev.some((conversation) => conversation.id === id);
          const next = exists
            ? prev.map((conversation) =>
                conversation.id === id ? data.conversation : conversation
              )
            : [data.conversation, ...prev];
          return [...next].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
        });
      } catch {
        void load(filtersRef.current, { silent: true });
      }
    },
    [load]
  );

  const channels = useMemo(() => {
    const keys = new Set<string>([`user:${user.id}`]);
    for (const key of teamKeys) keys.add(`inbox:${key}`);
    return [...keys];
  }, [teamKeys, user.id]);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useInboxRealtime(channels, (event: RealtimeEnvelope) => {
    const conversationId =
      typeof event.payload.conversationId === 'string' ? event.payload.conversationId : null;
    if (!conversationId) return;
    if (
      ['message', 'message_status', 'message_media', 'conversation', 'note'].includes(event.type)
    ) {
      void refreshConversation(conversationId);
      if (conversationId === selectedRef.current) setThreadVersion((version) => version + 1);
    }
  });

  if (accounts.length === 0) {
    return (
      <div className="area-comms-placeholder">
        <p className="area-comms-placeholder-title">Sin canales externos</p>
        <p>
          {areaLabel} todavía no tiene números de WhatsApp, SMS o Telegram asignados a su equipo.
          Administración los asigna en Canales y responsables; mientras tanto, el canal del área y
          las solicitudes funcionan con normalidad.
        </p>
        {inboxTeamKeys.length > 0 ? (
          <p>
            Cómo se asigna: en <strong>Administración · Canales y responsables</strong>, en la
            pestaña Canales, se edita el canal y se marca el equipo{' '}
            {inboxTeamKeys.map((key, index) => (
              <span key={key}>
                {index > 0 ? ' o ' : null}
                <code>{key}</code>
              </span>
            ))}
            . Ese rol es el que conecta el canal con esta pestaña; quien lo tenga (y pueda usar la
            bandeja) verá aquí sus conversaciones.
          </p>
        ) : null}
      </div>
    );
  }

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const showList = !isMobile || mobileView === 'list';
  const showConversation = !isMobile || mobileView === 'conversation';
  const showAi = selected && (isMobile ? mobileView === 'ai' : aiOpen);

  return (
    <>
      {showList ? (
        <div className="area-comms-rail">
          <ConversationList
            accounts={accounts}
            filters={filters}
            onFiltersChange={setFilters}
            conversations={conversations}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setDraft('');
              if (isMobile) setMobileView('conversation');
            }}
            loading={loading}
            error={error}
            hasMore={Boolean(nextCursor)}
            onLoadMore={loadMore}
            onRetry={() => void load(filters)}
            fullWidth
            hideAccountFilter
            hideNewConversation
          />
        </div>
      ) : null}

      {showConversation ? (
        <div className="area-comms-main chat-page-main">
          {selected ? (
            <ConversationView
              key={selected.id}
              conversation={selected}
              user={user}
              users={users}
              draft={draft}
              onDraftChange={setDraft}
              threadVersion={threadVersion}
              onConversationChanged={(conversation) =>
                setConversations((prev) =>
                  prev.map((item) => (item.id === conversation.id ? conversation : item))
                )
              }
              onBack={isMobile ? () => setMobileView('list') : undefined}
              onToggleAi={() => (isMobile ? setMobileView('ai') : setAiOpen((value) => !value))}
              aiOpen={Boolean(showAi)}
              insertAttachment={attachSeed}
              onInsertAttachmentConsumed={() => setAttachSeed(null)}
            />
          ) : (
            <div className="area-comms-placeholder">
              <p className="area-comms-placeholder-title">
                {handoff ? 'Elige con quién hablar' : 'Selecciona una conversación'}
              </p>
              <p>
                {handoff
                  ? 'Traes un borrador preparado: en cuanto abras la conversación del cliente aparecerá en el redactor.'
                  : `Aquí ves los mensajes de los clientes y proveedores que llegan a los canales de ${areaLabel}.`}
              </p>
            </div>
          )}
        </div>
      ) : null}

      {showAi && selected ? (
        <aside className="area-comms-aside" aria-label="Copiloto de la bandeja">
          <CopilotPanel
            key={selected.id}
            conversation={selected}
            user={user}
            onInsertDraft={(text) => {
              setDraft(text);
              if (isMobile) setMobileView('conversation');
            }}
            onInsertAttachment={(attachment) => {
              setAttachSeed({ ...attachment, key: `${attachment.objectId}-${Date.now()}` });
              if (isMobile) setMobileView('conversation');
            }}
            onRefreshConversation={() => void refreshConversation(selected.id)}
            onBack={isMobile ? () => setMobileView('conversation') : undefined}
          />
        </aside>
      ) : null}
    </>
  );
}
