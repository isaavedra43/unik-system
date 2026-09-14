import { describe, expect, it, vi } from 'vitest';

// The real registry (every tool file registers itself on import). Prisma is
// never touched at import time, but the client must not try to connect.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { getAllTools } from './tools/index';
import { CORE_TOOL_NAMES, PROVIDER_MAX_TOOLS, findToolsByTopic, selectToolsForTurn } from './tool-selector';

/**
 * Regression for the production error
 * "400 Invalid 'tools': array too long. Expected an array with maximum length 128, but got 130".
 * The full registry is larger than the OpenAI limit; every turn must offer fewer.
 */
describe('tool selection against the real registry', () => {
  const tools = getAllTools();

  it('the registry is larger than the provider limit (so selection is required)', () => {
    expect(tools.length).toBeGreaterThan(PROVIDER_MAX_TOOLS);
  });

  const cases: Array<{ message: string; expectAll: string[] }> = [
    { message: 'llama a papa y dile con la ia que tiene que ir a recoger el material de esta orden de venta: ov-24430', expectAll: ['callContact', 'querySalesOrders', 'getPickupLocation'] },
    { message: 'mandale el reporte de entregas a pie de obra la semana pasada', expectAll: ['querySalesOrders', 'generatePdfReport', 'sendInternalChatMessage', 'sendMessageToContact'] },
    { message: 'dime las vetnas en efectivo de la semana pasada', expectAll: ['querySalesOrders', 'getCashCloseReconciliation'] },
    { message: 'generame una cotizacion a nombre unik de 20 m2 de piel de elefante 20xll', expectAll: ['draftQuoteFromRequest', 'createQuote', 'getQuotePdf', 'searchQuoteProducts'] },
    { message: 'marcale a papa por telefono interno', expectAll: ['startInternalCall', 'callContact'] },
    { message: 'mandale mensaje a papa diciendole hola', expectAll: ['sendInternalChatMessage', 'sendMessageToContact', 'listChatChannels'] },
    { message: 'sube esta factura y créame la bill', expectAll: ['extractDocumentData', 'draftBillFromDocument', 'listConversationAttachments'] },
  ];

  for (const c of cases) {
    it(`offers ≤96 tools with the right ones for: "${c.message.slice(0, 40)}…"`, () => {
      const res = selectToolsForTurn({ tools, message: c.message, maxTools: 96, pinned: ['proposeChatDraft', 'suggestNextActions'] });
      expect(res.offered.length).toBeLessThanOrEqual(96);
      const names = new Set(res.offered.map((t) => t.name));
      for (const core of CORE_TOOL_NAMES) if (tools.some((t) => t.name === core)) expect(names.has(core)).toBe(true);
      for (const expected of c.expectAll) expect(names.has(expected), `missing ${expected}`).toBe(true);
    });
  }

  it('loadMoreTools can reach any dropped tool by topic', () => {
    const res = selectToolsForTurn({ tools, message: 'hola', maxTools: 40 });
    const dropped = new Set(res.dropped.map((t) => t.name));
    expect(dropped.size).toBeGreaterThan(0);
    const campaigns = findToolsByTopic(tools, 'campañas de whatsapp').map((t) => t.name);
    expect(campaigns).toContain('listCampaigns');
    const skills = findToolsByTopic(tools, 'ejecutar una skill').map((t) => t.name);
    expect(skills).toContain('runSkill');
  });
});
