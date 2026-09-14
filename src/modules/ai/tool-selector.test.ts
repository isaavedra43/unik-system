import { describe, expect, it } from 'vitest';
import { CORE_TOOL_NAMES, PROVIDER_MAX_TOOLS, detectDomains, findToolsByTopic, selectToolsForTurn, type SelectableTool } from './tool-selector';

function tool(name: string, description = '', category = 'sales', effect = 'read'): SelectableTool {
  return { name, description, category, effect };
}

const REAL_NAMES = [
  'querySalesOrders', 'getSalesOrderDetail', 'universalSearch', 'getDatabaseOverview', 'queryQuotes', 'getQuoteDetail', 'searchQuoteCustomers',
  'searchQuoteProducts', 'previewQuote', 'createQuote', 'updateQuote', 'getQuotePdf', 'draftQuoteFromRequest', 'sendQuoteToContact',
  'findSimilarPastQuotes', 'checkStockForRequest', 'callContact', 'startInternalCall', 'listCalls', 'getCallTranscript', 'sendMessageToContact',
  'sendBulkMessages', 'sendInternalChatMessage', 'listChatChannels', 'queryInvoices', 'queryPayments', 'queryPurchaseOrders', 'queryBills',
  'queryPackages', 'queryProducts', 'queryContacts', 'getTopProducts', 'getSalesTrend', 'generatePdfReport', 'generateExcelReport',
  'generateWordReport', 'generateTable', 'generateChart', 'searchKnowledgeLibrary', 'rememberForUser', 'listSkills', 'runSkill',
  'getWorkDigest', 'getRecentActivity', 'loadMoreTools', 'proposePlan', 'getCurrentUserContext', 'getSystemTime', 'getPickupLocation',
  'listCampaigns', 'approveCampaign', 'extractDocumentData', 'draftBillFromDocument', 'listConversationAttachments', 'listArtifacts', 'getArtifactSpec',
];

function bigCatalog(): SelectableTool[] {
  const named = REAL_NAMES.map((n) => tool(n, `Herramienta ${n}`));
  const filler = Array.from({ length: 150 }, (_, i) => tool(`fillerTool${i}`, 'Consulta genérica de relleno', 'system'));
  return [...named, ...filler];
}

describe('selectToolsForTurn', () => {
  it('never exceeds the provider limit and keeps the core tools', () => {
    const tools = bigCatalog();
    const res = selectToolsForTurn({ tools, message: 'hola', maxTools: 500 });
    expect(res.offered.length).toBeLessThanOrEqual(PROVIDER_MAX_TOOLS);
    for (const core of CORE_TOOL_NAMES) if (tools.some((t) => t.name === core)) expect(res.offered.map((t) => t.name)).toContain(core);
  });

  it('returns everything untouched when it already fits', () => {
    const tools = REAL_NAMES.slice(0, 10).map((n) => tool(n));
    const res = selectToolsForTurn({ tools, message: 'lo que sea', maxTools: 96 });
    expect(res.offered).toHaveLength(10);
    expect(res.dropped).toHaveLength(0);
  });

  it('prefers the tools of the message domain (quotes)', () => {
    const res = selectToolsForTurn({ tools: bigCatalog(), message: 'generame una cotizacion a nombre unik de 20 m2 de piel de elefante 20xll', maxTools: 40 });
    const names = res.offered.map((t) => t.name);
    expect(names).toContain('draftQuoteFromRequest');
    expect(names).toContain('createQuote');
    expect(names).toContain('getQuotePdf');
    expect(res.domains).toContain('quotes');
  });

  it('prefers call tools for "marcale a papa por telefono"', () => {
    const res = selectToolsForTurn({ tools: bigCatalog(), message: 'marcale a papa por telefono interno', maxTools: 30 });
    const names = res.offered.map((t) => t.name);
    expect(names).toContain('startInternalCall');
    expect(names).toContain('callContact');
  });

  it('keeps tools used earlier in the conversation and pinned surface tools', () => {
    const res = selectToolsForTurn({ tools: bigCatalog(), message: 'ok hazlo', recentToolNames: ['approveCampaign'], pinned: ['listCampaigns'], maxTools: 30 });
    const names = res.offered.map((t) => t.name);
    expect(names).toContain('approveCampaign');
    expect(names).toContain('listCampaigns');
  });

  it('keeps the registration order of the offered tools (stable prompts)', () => {
    const tools = bigCatalog();
    const res = selectToolsForTurn({ tools, message: 'dime las ventas en efectivo de la semana pasada', maxTools: 40 });
    const indexes = res.offered.map((t) => tools.indexOf(t));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });
});

describe('findToolsByTopic / detectDomains', () => {
  it('finds tools by Spanish topic words', () => {
    const names = findToolsByTopic(bigCatalog(), 'llamar por teléfono').map((t) => t.name);
    expect(names).toContain('callContact');
    expect(names).toContain('startInternalCall');
    expect(names).not.toContain('fillerTool1');
  });

  it('detects several domains in one message', () => {
    const domains = detectDomains('mandale el reporte de entregas a pie de obra de la semana pasada por whatsapp');
    expect(domains).toEqual(expect.arrayContaining(['sales', 'documents', 'messaging']));
  });
});
