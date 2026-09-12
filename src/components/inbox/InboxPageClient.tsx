'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConversationList } from './ConversationList';
import { ConversationView } from './ConversationView';
import { CopilotPanel } from './copilot/CopilotPanel';
import { NewConversationDialog } from './NewConversationDialog';
import { useInboxRealtime } from './useInboxRealtime';
import { useIsMobile } from './useIsMobile';
import {
  apiJson,
  type CommAccountDTO,
  type CommConversationDTO,
  type InboxFilters,
  type InboxUserInfo,
  type InboxUserOption,
  type RealtimeEnvelope,
} from './inbox-types';

/**
 * Omnichannel inbox: conversations (left), thread + composer (center) and the
 * AI copilot (right). On mobile one column is visible at a time.
 * Realtime updates come from the generic SSE stream (team + user channels);
 * payloads only carry ids, so the client re-fetches what it shows.
 */

type MobileView = 'list' | 'conversation' | 'ai';

const DEFAULT_FILTERS: InboxFilters = {
  accountId: '',
  status: 'open',
  assigned: 'all',
  search: '',
};

export function InboxPageClient({ user }: { user: InboxUserInfo }) {
  const isMobile = useIsMobile();
  const [accounts, setAccounts] = useState<CommAccountDTO[]>([]);
  const [users, setUsers] = useState<InboxUserOption[]>([]);
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_FILTERS);
  const [conversations, setConversations] = useState<CommConversationDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>('list');
  const [aiOpen, setAiOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [threadVersion, setThreadVersion] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const buildQuery = useCallback((f: InboxFilters, cursor?: string | null) => {
    const q = new URLSearchParams();
    if (f.accountId) q.set('accountId', f.accountId);
    q.set('status', f.status);
    if (f.assigned !== 'all') q.set('assigned', f.assigned);
    if (f.search.trim()) q.set('search', f.search.trim());
    if (cursor) q.set('cursor', cursor);
    q.set('limit', '30');
    return q.toString();
  }, []);

  const loadConversations = useCallback(
    async (f: InboxFilters, options: { silent?: boolean } = {}) => {
      if (!options.silent) setListLoading(true);
      try {
        const data = await apiJson<{ items: CommConversationDTO[]; nextCursor: string | null }>(
          `/app/inbox/api/conversations?${buildQuery(f)}`
        );
        setConversations(data.items);
        setNextCursor(data.nextCursor);
        setListError(null);
      } catch (err) {
        setListError(err instanceof Error ? err.message : 'No se pudo cargar la bandeja');
      } finally {
        setListLoading(false);
      }
    },
    [buildQuery]
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const data = await apiJson<{ items: CommConversationDTO[]; nextCursor: string | null }>(
        `/app/inbox/api/conversations?${buildQuery(filtersRef.current, nextCursor)}`
      );
      setConversations((prev) => {
        const ids = new Set(prev.map((c) => c.id));
        return [...prev, ...data.items.filter((c) => !ids.has(c.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cargar más');
    }
  }, [buildQuery, nextCursor]);

  useEffect(() => {
    apiJson<{ accounts: CommAccountDTO[] }>('/app/inbox/api/accounts')
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]));
    apiJson<{ users: InboxUserOption[] }>('/app/inbox/api/users')
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => loadConversations(filters), filters.search ? 300 : 0);
    return () => clearTimeout(handle);
  }, [filters, loadConversations]);

  const refreshConversation = useCallback(
    async (id: string) => {
      try {
        const data = await apiJson<{ conversation: CommConversationDTO }>(
          `/app/inbox/api/conversations/${id}`
        );
        setConversations((prev) => {
          const exists = prev.some((c) => c.id === id);
          const next = exists
            ? prev.map((c) => (c.id === id ? data.conversation : c))
            : [data.conversation, ...prev];
          return [...next].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
        });
      } catch {
        // The conversation may have left the current filter; reload silently.
        loadConversations(filtersRef.current, { silent: true });
      }
    },
    [loadConversations]
  );

  const channels = useMemo(() => {
    const keys = new Set<string>([`user:${user.id}`]);
    for (const key of user.roleKeys) keys.add(`inbox:${key}`);
    for (const account of accounts) for (const key of account.teamKeys) keys.add(`inbox:${key}`);
    return [...keys];
  }, [accounts, user.id, user.roleKeys]);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useInboxRealtime(channels, (event: RealtimeEnvelope) => {
    const conversationId =
      typeof event.payload.conversationId === 'string' ? event.payload.conversationId : null;
    if (!conversationId) return;
    if (['message', 'message_status', 'message_media', 'conversation', 'note'].includes(event.type)) {
      refreshConversation(conversationId);
      if (conversationId === selectedRef.current) setThreadVersion((v) => v + 1);
    }
    if (
      event.type === 'message' &&
      event.payload.direction === 'inbound' &&
      conversationId !== selectedRef.current
    ) {
      toast.message('Nuevo mensaje en la bandeja');
    }
  });

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const selectConversation = (id: string) => {
    setSelectedId(id);
    setDraft('');
    if (isMobile) setMobileView('conversation');
  };

  const onConversationChanged = (conversation: CommConversationDTO) => {
    setConversations((prev) => prev.map((c) => (c.id === conversation.id ? conversation : c)));
  };

  const showList = !isMobile || mobileView === 'list';
  const showConversation = !isMobile || mobileView === 'conversation';
  const showAi = selected && (isMobile ? mobileView === 'ai' : aiOpen);

  return (
    <div className="chat-page" style={{ height: 'calc(100vh - var(--unik-topbar-height, 60px))' }}>
      <div className="chat-page-body">
        {showList && (
          <div
            className="chat-sidebar-wrapper"
            style={isMobile ? { width: '100%', flex: 1 } : undefined}
          >
            <ConversationList
              accounts={accounts}
              filters={filters}
              onFiltersChange={setFilters}
              conversations={conversations}
              selectedId={selectedId}
              onSelect={selectConversation}
              loading={listLoading}
              error={listError}
              hasMore={Boolean(nextCursor)}
              onLoadMore={loadMore}
              onRetry={() => loadConversations(filters)}
              fullWidth={isMobile}
              onNewConversation={() => setNewOpen(true)}
            />
          </div>
        )}
        {showConversation && (
          <div className="chat-page-main" style={isMobile ? { width: '100%' } : undefined}>
            {selected ? (
              <ConversationView
                key={selected.id}
                conversation={selected}
                user={user}
                users={users}
                draft={draft}
                onDraftChange={setDraft}
                threadVersion={threadVersion}
                onConversationChanged={onConversationChanged}
                onBack={isMobile ? () => setMobileView('list') : undefined}
                onToggleAi={() => (isMobile ? setMobileView('ai') : setAiOpen((v) => !v))}
                aiOpen={Boolean(showAi)}
              />
            ) : (
              <div
                className="chat-empty-state"
                style={{ margin: 'auto', textAlign: 'center', padding: '2rem' }}
              >
                <h3 className="chat-empty-state-title">Selecciona una conversación</h3>
                <p className="chat-empty-state-text">
                  Los mensajes de WhatsApp, SMS y Telegram de tus equipos aparecen a la izquierda.
                </p>
              </div>
            )}
          </div>
        )}
        {showAi && selected && (
          <aside
            aria-label="Copiloto de IA"
            style={{
              width: isMobile ? '100%' : 'clamp(340px, 26vw, 400px)',
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              borderLeft: isMobile ? 'none' : '1px solid var(--unik-border)',
              background: 'var(--unik-surface)',
              overflow: 'hidden',
            }}
          >
            <CopilotPanel
              key={selected.id}
              conversation={selected}
              user={user}
              onInsertDraft={(text) => {
                setDraft(text);
                if (isMobile) setMobileView('conversation');
              }}
              onRefreshConversation={() => refreshConversation(selected.id)}
              onBack={isMobile ? () => setMobileView('conversation') : undefined}
            />
          </aside>
        )}
      </div>
      <NewConversationDialog
        open={newOpen}
        accounts={accounts}
        onClose={() => setNewOpen(false)}
        onCreated={(conversation) => {
          setConversations((prev) => [
            conversation,
            ...prev.filter((c) => c.id !== conversation.id),
          ]);
          selectConversation(conversation.id);
          setThreadVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
