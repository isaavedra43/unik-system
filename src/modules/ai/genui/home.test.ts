import { describe, expect, it } from 'vitest';
import { buildHomeSpec, frequentPrompts, isHomeEmpty, type HomeData } from './home';
import { sanitizeGenUiSpec } from './validate';

const base: HomeData = {
  firstName: 'Iván',
  agent: { name: 'Director', kind: 'principal' },
  proposals: [],
  stalled: [],
  working: 0,
  followUps: [],
  routines: [],
  frequent: [],
  recent: [],
  files: [],
  notifications: [],
  discover: [],
};

describe('buildHomeSpec', () => {
  it('builds a valid spec from the real sections only', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const spec = buildHomeSpec(
      {
        ...base,
        proposals: [
          {
            id: 'prop_1',
            summary: 'Enviar cotización COT-12 a Mármoles del Norte',
            conversationId: 'c1',
            expiresAt: '2026-09-26T18:00:00Z',
          },
        ],
        stalled: [
          {
            kind: 'task',
            title: 'Investigar precios',
            status: 'failed',
            conversationId: 'c2',
            detail: 'timeout',
          },
        ],
        working: 2,
        followUps: [
          { conversationId: 'c1', conversationTitle: 'Ventas', text: 'Compara con agosto' },
        ],
        routines: [{ title: 'Resumen diario', nextRunAt: '2026-09-27T14:00:00Z', paused: false }],
        frequent: [{ text: 'ventas de ayer por sucursal', count: 5 }],
        recent: [{ id: 'c1', title: 'Ventas', updatedAt: '2026-09-26T11:00:00Z', snippet: null }],
        files: [
          {
            artifactId: 'art_1',
            name: 'ventas.pdf',
            mimeType: 'application/pdf',
            createdAt: '2026-09-25T10:00:00Z',
          },
        ],
        notifications: [
          { title: 'Pedido entregado', body: null, url: null, createdAt: '2026-09-26T10:00:00Z' },
        ],
        discover: [
          {
            id: 'web',
            label: 'Investiga en internet',
            description: 'x',
            prompt: 'Investiga…',
            icon: 'globe',
          },
        ],
      },
      now
    );
    const { spec: clean, issues } = sanitizeGenUiSpec(spec);
    expect(issues).toEqual([]);
    const types = Object.values(clean!.elements).map((e) => e.type);
    expect(types).toContain('Card');
    expect(types).toContain('Timeline');
    expect(types).toContain('FilePreview');
    // The approval buttons carry the real proposal id and decide through the API.
    const approve = Object.values(clean!.elements).find(
      (e) => e.type === 'Button' && e.props.label === 'Aprobar'
    );
    expect(approve?.on).toEqual({
      press: { action: 'decideProposal', params: { proposalId: 'prop_1', decision: 'approve' } },
    });
    // Next steps reopen the thread and prefill the follow-up.
    const next = Object.values(clean!.elements).find(
      (e) => e.type === 'Button' && e.props.label === 'Compara con agosto'
    );
    expect(Array.isArray(next?.on?.press)).toBe(true);
  });

  it('is empty for a brand-new user', () => {
    expect(isHomeEmpty(base)).toBe(true);
    expect(isHomeEmpty({ ...base, working: 1 })).toBe(false);
  });
});

describe('frequentPrompts', () => {
  it('groups repeated requests (accents, case, punctuation) and ignores one-offs and system text', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h));
    const out = frequentPrompts([
      { content: '¿Cuánto vendimos ayer por sucursal?', createdAt: at(1) },
      { content: 'cuanto vendimos ayer por sucursal', createdAt: at(5) },
      { content: 'Cuánto vendimos ayer por sucursal', createdAt: at(9) },
      { content: 'Hazme un PDF de cobranza vencida', createdAt: at(2) },
      { content: 'hazme un pdf de cobranza vencida', createdAt: at(3) },
      { content: 'Una sola vez esto', createdAt: at(4) },
      { content: '⟦auto:open⟧ algo', createdAt: at(6) },
      { content: '⟦auto:open⟧ algo', createdAt: at(7) },
    ]);
    expect(out).toEqual([
      { text: 'Cuánto vendimos ayer por sucursal', count: 3 },
      { text: 'hazme un pdf de cobranza vencida', count: 2 },
    ]);
  });
});
