import type { GenUiElement, GenUiSpec } from './catalog';

/**
 * Personalized home — what the empty thread shows instead of fixed ideas:
 * decisions waiting on the user, work that stalled, what the team is doing,
 * next steps from recent answers, upcoming routines, what the user asks for
 * most, recent threads and files, unread events, and capabilities they have
 * never tried (progressive discovery).
 *
 * Everything comes from the user's own records (never sample data). It
 * "learns" from use without extra storage: clicking a card sends a message,
 * and repeated messages are exactly what ranks "Lo que más pides".
 *
 * `buildHomeSpec` is pure (unit tested); `loadHomeData` does the queries.
 */

export interface HomeData {
  firstName: string;
  agent: { name: string; kind: 'principal' | 'specialist'; purpose?: string | null };
  proposals: Array<{
    id: string;
    summary: string;
    conversationId: string | null;
    expiresAt: string;
  }>;
  stalled: Array<{
    kind: 'task' | 'mission';
    title: string;
    status: string;
    conversationId: string | null;
    detail?: string | null;
  }>;
  working: number;
  followUps: Array<{ conversationId: string; conversationTitle: string; text: string }>;
  routines: Array<{ title: string; nextRunAt: string | null; paused: boolean }>;
  frequent: Array<{ text: string; count: number }>;
  recent: Array<{ id: string; title: string; updatedAt: string; snippet: string | null }>;
  files: Array<{
    artifactId: string;
    name: string;
    mimeType: string | null;
    createdAt: string;
  }>;
  notifications: Array<{
    title: string;
    body: string | null;
    url: string | null;
    createdAt: string;
  }>;
  discover: Array<{ id: string; label: string; description: string; prompt: string; icon: string }>;
}

function when(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const txt = min < 60 ? `${Math.max(1, min)} min` : hrs < 48 ? `${hrs} h` : `${days} d`;
  return diff >= 0 ? `en ${txt}` : `hace ${txt}`;
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const MIME_BY_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  image: 'image/png',
};

export function mimeForArtifact(type: string): string | null {
  return MIME_BY_TYPE[type] ?? null;
}

export function buildHomeSpec(d: HomeData, now = Date.now()): GenUiSpec {
  const elements: Record<string, GenUiElement> = {};
  const sections: string[] = [];
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const add = (key: string, el: GenUiElement) => {
    elements[key] = { children: [], ...el };
    return key;
  };

  // 1. Decisions waiting on the user.
  if (d.proposals.length > 0) {
    const rows = d.proposals.slice(0, 3).map((p) => {
      const row = id('p');
      const approve = add(id('ap'), {
        type: 'Button',
        props: { label: 'Aprobar', variant: 'primary', icon: 'check' },
        on: {
          press: {
            action: 'decideProposal',
            params: { proposalId: p.id, decision: 'approve' },
          },
        },
      });
      const reject = add(id('rj'), {
        type: 'Button',
        props: { label: 'Rechazar', variant: 'ghost' },
        on: {
          press: { action: 'decideProposal', params: { proposalId: p.id, decision: 'reject' } },
        },
      });
      const text = add(id('pt'), {
        type: 'Text',
        props: { text: cut(p.summary, 180), weight: 'medium' },
      });
      const meta = add(id('pm'), {
        type: 'Text',
        props: { text: `Vence ${when(p.expiresAt, now)}`, tone: 'muted', size: 'sm' },
      });
      const buttons = add(id('pb'), {
        type: 'Stack',
        props: { direction: 'horizontal', gap: 'sm' },
        children: [approve, reject],
      });
      return add(row, {
        type: 'Stack',
        props: { gap: 'xs' },
        children: [text, meta, buttons],
      });
    });
    sections.push(
      add('decide', {
        type: 'Card',
        props: {
          title: 'Necesita tu decisión',
          subtitle: `${d.proposals.length} acción${d.proposals.length > 1 ? 'es' : ''} esperando aprobación`,
          icon: 'shield',
          tone: 'warning',
        },
        children: [add(id('dl'), { type: 'Stack', props: { gap: 'md' }, children: rows })],
      })
    );
  }

  // 2. Work that stalled + what the team is doing now.
  if (d.stalled.length > 0 || d.working > 0) {
    const kids: string[] = [];
    if (d.working > 0) {
      kids.push(
        add(id('w'), {
          type: 'Callout',
          props: {
            title: `Tu equipo trabaja en ${d.working} tarea${d.working > 1 ? 's' : ''}`,
            body: 'Te aviso cuando entreguen.',
            tone: 'info',
          },
        })
      );
    }
    if (d.stalled.length > 0) {
      kids.push(
        add(id('sl'), {
          type: 'List',
          props: {
            items: d.stalled.slice(0, 4).map((s) => ({
              title: cut(s.title, 120),
              subtitle: s.detail ? cut(s.detail, 140) : undefined,
              badge:
                s.status === 'failed'
                  ? 'Falló'
                  : s.status === 'blocked'
                    ? 'Detenida'
                    : s.status === 'awaiting_approval'
                      ? 'Por aprobar'
                      : 'Pendiente',
              tone: s.status === 'failed' ? 'danger' : 'warning',
            })),
          },
        })
      );
      const first = d.stalled[0];
      kids.push(
        add(id('sc'), {
          type: 'Button',
          props: { label: 'Retomar lo pendiente', variant: 'secondary', icon: 'play' },
          on: {
            press: {
              action: 'ask',
              params: {
                text: `Retoma lo que quedó pendiente: "${cut(first.title, 140)}". Dime qué falló y termínalo.`,
              },
            },
          },
        })
      );
    }
    sections.push(
      add('pending', {
        type: 'Card',
        props: { title: 'Quedó pendiente', icon: 'clock' },
        children: [add(id('pk'), { type: 'Stack', props: { gap: 'sm' }, children: kids })],
      })
    );
  }

  // 3. Next steps suggested by recent answers.
  if (d.followUps.length > 0) {
    const buttons = d.followUps.slice(0, 4).map((f) =>
      add(id('f'), {
        type: 'Button',
        props: { label: cut(f.text, 56), variant: 'secondary', icon: 'sparkles' },
        on: {
          press: [
            { action: 'openConversation', params: { conversationId: f.conversationId } },
            { action: 'prefill', params: { text: f.text } },
          ],
        },
      })
    );
    sections.push(
      add('next', {
        type: 'Card',
        props: {
          title: 'Siguientes pasos',
          subtitle: 'Lo que quedó sugerido en tus conversaciones recientes',
          icon: 'target',
        },
        children: [
          add(id('fs'), {
            type: 'Stack',
            props: { direction: 'horizontal', gap: 'sm', wrap: true },
            children: buttons,
          }),
        ],
      })
    );
  }

  // 4. What the user asks for most (learned from their own messages).
  if (d.frequent.length > 0) {
    const buttons = d.frequent.slice(0, 4).map((f) =>
      add(id('q'), {
        type: 'Button',
        props: { label: cut(f.text, 56), variant: 'secondary', icon: 'repeat' },
        on: { press: { action: 'ask', params: { text: f.text } } },
      })
    );
    sections.push(
      add('frequent', {
        type: 'Card',
        props: { title: 'Lo que más pides', subtitle: 'Un clic y lo hago de nuevo', icon: 'zap' },
        children: [
          add(id('qs'), {
            type: 'Stack',
            props: { direction: 'horizontal', gap: 'sm', wrap: true },
            children: buttons,
          }),
        ],
      })
    );
  }

  // 5. Routines coming up.
  if (d.routines.length > 0) {
    sections.push(
      add('routines', {
        type: 'Card',
        props: { title: 'Rutinas', icon: 'repeat' },
        children: [
          add(id('rt'), {
            type: 'Timeline',
            props: {
              items: d.routines.slice(0, 4).map((r) => ({
                title: cut(r.title, 120),
                time: r.paused ? 'En pausa' : r.nextRunAt ? when(r.nextRunAt, now) : 'Sin horario',
                tone: r.paused ? 'warning' : 'info',
              })),
            },
          }),
        ],
      })
    );
  }

  // 6. Unread events.
  if (d.notifications.length > 0) {
    sections.push(
      add('events', {
        type: 'Card',
        props: { title: 'Novedades', icon: 'bell' },
        children: [
          add(id('ev'), {
            type: 'List',
            props: {
              items: d.notifications.slice(0, 3).map((x) => ({
                title: cut(x.title, 120),
                subtitle: x.body ? cut(x.body, 140) : undefined,
                meta: when(x.createdAt, now),
              })),
            },
          }),
        ],
      })
    );
  }

  // 7. Pick up where you left off.
  if (d.recent.length > 0) {
    const rows = d.recent.slice(0, 3).map((c) =>
      add(id('c'), {
        type: 'Button',
        props: { label: cut(c.title, 48), variant: 'ghost', icon: 'message' },
        on: { press: { action: 'openConversation', params: { conversationId: c.id } } },
      })
    );
    sections.push(
      add('recent', {
        type: 'Card',
        props: { title: 'Retomar', icon: 'message' },
        children: [add(id('cs'), { type: 'Stack', props: { gap: 'xs' }, children: rows })],
      })
    );
  }

  // 8. Recent files.
  if (d.files.length > 0) {
    const previews = d.files.slice(0, 3).map((f) =>
      add(id('fl'), {
        type: 'FilePreview',
        props: {
          name: cut(f.name, 120),
          artifactId: f.artifactId,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
        },
      })
    );
    sections.push(
      add('files', {
        type: 'Card',
        props: { title: 'Archivos recientes', icon: 'folder' },
        children: [add(id('fp'), { type: 'Stack', props: { gap: 'sm' }, children: previews })],
      })
    );
  }

  // 9. Progressive discovery: powers the user never tried.
  if (d.discover.length > 0) {
    const cards = d.discover.slice(0, 3).map((c) =>
      add(id('dc'), {
        type: 'Card',
        props: { title: c.label, subtitle: c.description, icon: c.icon },
        children: [
          add(id('db'), {
            type: 'Button',
            props: { label: 'Probar', variant: 'ghost', icon: 'play' },
            on: { press: { action: 'prefill', params: { text: c.prompt } } },
          }),
        ],
      })
    );
    sections.push(
      add('discover', {
        type: 'Stack',
        props: { gap: 'sm' },
        children: [
          add(id('dh'), { type: 'Heading', props: { text: 'Prueba algo nuevo', level: 3 } }),
          add(id('dg'), { type: 'Grid', props: { columns: 3, gap: 'sm' }, children: cards }),
        ],
      })
    );
  }

  const root = add('home', {
    type: 'Grid',
    props: { columns: 2, gap: 'md' },
    children: sections.filter((s) => s !== 'discover'),
  });
  // Discovery spans the whole width under the grid.
  if (sections.includes('discover')) {
    const wrap = add('homeWrap', {
      type: 'Stack',
      props: { gap: 'lg' },
      children: [...(elements[root].children!.length > 0 ? [root] : []), 'discover'],
    });
    return { root: wrap, elements };
  }
  return { root, elements };
}

/** True when there is nothing personal to show yet (brand-new user). */
export function isHomeEmpty(d: HomeData): boolean {
  return (
    d.proposals.length === 0 &&
    d.stalled.length === 0 &&
    d.working === 0 &&
    d.followUps.length === 0 &&
    d.routines.length === 0 &&
    d.frequent.length === 0 &&
    d.recent.length === 0 &&
    d.files.length === 0 &&
    d.notifications.length === 0
  );
}

/** Normalized form used to group repeated requests. */
export function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Requests repeated at least twice, most frequent (then most recent) first. */
export function frequentPrompts(
  messages: Array<{ content: string; createdAt: Date }>,
  limit = 4
): Array<{ text: string; count: number }> {
  const groups = new Map<string, { text: string; count: number; last: number }>();
  for (const m of messages) {
    const content = m.content.trim();
    if (content.length < 8 || content.length > 240) continue;
    if (content.startsWith('⟦') || content.startsWith('[Sistema]')) continue;
    const key = normalizePrompt(content);
    if (key.split(' ').length < 2) continue;
    const g = groups.get(key);
    const at = m.createdAt.getTime();
    if (g) {
      g.count += 1;
      if (at > g.last) {
        g.last = at;
        g.text = content;
      }
    } else groups.set(key, { text: content, count: 1, last: at });
  }
  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
    .map(({ text, count }) => ({ text, count }));
}
