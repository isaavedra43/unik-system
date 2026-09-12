import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * An official quote requested through the assistant NEVER reaches Books
 * without a human approval: the executor turns `approveOfficialQuote` into
 * a proposal; only the approved proposal (skipApproval by the proposals
 * service) executes the Books creation.
 */

const { db, proposals } = vi.hoisted(() => ({
  db: {
    current: null as null | ReturnType<
      typeof import('@/modules/campaigns/testing/in-memory-prisma').createInMemoryPrisma
    >,
  },
  proposals: [] as Array<{ id: string; toolName: string; summary: string; effect: string }>,
}));

vi.mock('@/lib/prisma', async () => {
  const { createInMemoryPrisma } = await import('@/modules/campaigns/testing/in-memory-prisma');
  db.current = createInMemoryPrisma({
    quote: {
      idPrefix: 'q',
      defaults: () => ({
        number: null,
        contactId: null,
        zohoCustomerId: null,
        zohoEstimateId: null,
        documentId: null,
        requestId: null,
        proposalId: null,
        approvedBy: null,
        approvedAt: null,
        syncedAt: null,
        invalidationReason: null,
        notes: null,
      }),
    },
    aiProposal: { idPrefix: 'prop' },
    product: {},
    storageConfig: { uniques: [['key']] },
  });
  return { prisma: db.current.prisma };
});
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: async () => undefined }));
vi.mock('@/modules/storage/storage-access', () => ({
  registerFileAccessResolver: () => undefined,
}));
vi.mock('@/modules/storage/storage-service', () => ({
  saveGeneratedFile: async () => ({ id: 'obj1' }),
}));
vi.mock('@/modules/ai/generators/pdf-generator', () => ({
  generatePdfReport: async () => ({ sizeBytes: 1, pageCount: 1 }),
}));
vi.mock('@/modules/extensions/proposals-service', () => ({
  createProposal: async (input: { tool: { name: string; effect?: string }; summary: string }) => {
    const p = {
      id: `prop-${proposals.length + 1}`,
      toolName: input.tool.name,
      summary: input.summary,
      effect: input.tool.effect ?? 'read',
      expiresAt: new Date(Date.now() + 1000),
    };
    proposals.push(p);
    return p;
  },
}));
vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: async () => undefined,
}));

import { executeTool } from '@/modules/ai/tools/registry';
import '@/modules/ai/tools/quotes-tools';

const seller: CurrentUser = {
  id: 'u1',
  username: 'u1',
  name: 'Vendedor',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['assistant.use', 'quotes.use'] as never,
  isSuperAdmin: false,
};
const approver: CurrentUser = {
  ...seller,
  id: 'u2',
  permissionKeys: ['assistant.use', 'quotes.use', 'quotes.approve'] as never,
};

beforeEach(() => {
  db.current!.reset();
  proposals.length = 0;
  process.env.ZOHO_BOOKS_MOCK = 'true';
});

describe('quotes tools', () => {
  it('prepareQuote creates a draft directly (no proposal, nothing in Books)', async () => {
    const res = await executeTool('prepareQuote', seller, {
      customerName: 'ACME',
      items: [{ name: 'Tornillo', quantity: 2, unitPrice: 5, taxRate: 0.16 }],
    });
    expect(res.success).toBe(true);
    const out = res.result as { quoteId: string; status: string; total: string };
    expect(out.status).toBe('draft');
    expect(out.total).toBe('11.6000');
    expect(proposals).toHaveLength(0);
    expect(db.current!.tables.quote.rows[0].zohoEstimateId).toBeNull();
  });

  it('an official quote request creates a proposal instead of touching Books', async () => {
    const draft = await executeTool('prepareQuote', seller, {
      customerName: 'ACME',
      items: [{ name: 'Tornillo', quantity: 2, unitPrice: 5, taxRate: 0.16 }],
    });
    const q = draft.result as { quoteId: string; contentHash: string; total: string };
    await executeTool('requestQuoteApproval', seller, { quoteId: q.quoteId });

    const res = await executeTool('approveOfficialQuote', approver, {
      quoteId: q.quoteId,
      customerName: 'ACME',
      total: q.total,
      currency: 'MXN',
      contentHash: q.contentHash,
    });
    expect(res.success).toBe(false);
    expect(res.needsApproval).toBe(true);
    expect(res.errorCode).toBe('needs_approval');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].effect).toBe('business_write');
    expect(proposals[0].summary).toContain('ACME');
    expect(proposals[0].summary).toContain('11.60');
    expect(db.current!.tables.quote.rows[0].status).toBe('pending_approval');
    expect(db.current!.tables.quote.rows[0].zohoEstimateId).toBeNull();
  });

  it('without quotes.approve the tool is refused even before proposing', async () => {
    const res = await executeTool('approveOfficialQuote', seller, {
      quoteId: 'q1',
      customerName: 'ACME',
      total: '1',
      currency: 'MXN',
      contentHash: 'abcdefgh',
    });
    expect(res.errorCode).toBe('forbidden');
    expect(proposals).toHaveLength(0);
  });

  it('the approved proposal executes exactly once against the current hash', async () => {
    const draft = await executeTool('prepareQuote', seller, {
      customerName: 'ACME',
      items: [{ name: 'Tornillo', quantity: 2, unitPrice: 5, taxRate: 0.16 }],
    });
    const q = draft.result as { quoteId: string; contentHash: string; total: string };
    await executeTool('requestQuoteApproval', seller, { quoteId: q.quoteId });
    const args = {
      quoteId: q.quoteId,
      customerName: 'ACME',
      total: q.total,
      currency: 'MXN',
      contentHash: q.contentHash,
    };

    const ok = await executeTool('approveOfficialQuote', approver, args, {
      skipApproval: true,
      approvedProposalId: 'prop-1',
    });
    expect(ok.success).toBe(true);
    expect((ok.result as { status: string }).status).toBe('synced');
    expect(db.current!.tables.quote.rows[0].proposalId).toBe('prop-1');

    // Stale proposal (old hash) after an edit fails instead of creating a duplicate.
    const again = await executeTool(
      'approveOfficialQuote',
      approver,
      { ...args, contentHash: 'stalestalestale' },
      { skipApproval: true }
    );
    expect(again.success).toBe(false);
  });
});
