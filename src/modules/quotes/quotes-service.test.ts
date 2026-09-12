import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Quotes: Decimal totals, versioning that drops previous approvals and
 * invalidates AI proposals, approval bound to the reviewed content hash,
 * Books sync (mock / uncertain) and the commercial package.
 */

const { db, audit, saved, books } = vi.hoisted(() => {
  const audit: Array<Record<string, unknown>> = [];
  const saved: Array<Record<string, unknown>> = [];
  const books = { impl: null as null | ((input: unknown) => Promise<unknown>) };
  // vi.hoisted runs before imports: build lazily through a require-free factory.
  return {
    db: {
      current: null as null | ReturnType<
        typeof import('@/modules/campaigns/testing/in-memory-prisma').createInMemoryPrisma
      >,
    },
    audit,
    saved,
    books,
  };
});

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
    product: { idPrefix: 'prod' },
    storageConfig: { idPrefix: 'cfg', uniques: [['key']] },
  });
  return { prisma: db.current.prisma };
});
vi.mock('@/modules/auth/audit-service', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audit.push(event);
  },
}));
vi.mock('@/modules/storage/storage-access', () => ({
  registerFileAccessResolver: () => undefined,
}));
vi.mock('@/modules/storage/storage-service', () => ({
  saveGeneratedFile: async (input: Record<string, unknown>) => {
    saved.push(input);
    return { id: `obj${saved.length}` };
  },
}));
vi.mock('@/modules/ai/generators/pdf-generator', () => ({
  generatePdfReport: async () => ({ sizeBytes: 1234, pageCount: 2 }),
}));
vi.mock('./zoho-books-adapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('./zoho-books-adapter')>();
  return {
    ...original,
    createEstimate: async (input: Parameters<typeof original.createEstimate>[0]) =>
      books.impl
        ? books.impl(input)
        : original.createEstimate(input, { env: { ZOHO_BOOKS_MOCK: 'true' } }),
  };
});

import { Prisma } from '@prisma/client';
import {
  approveQuote,
  buildCommercialPackage,
  createQuote,
  QuoteError,
  rejectQuote,
  requestApproval,
  simulateScenarios,
  updateQuote,
} from './quotes-service';
import { computeTotals, computeQuoteContentHash } from './quotes-contract';

const user = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  id: 'u1',
  username: 'u1',
  name: 'Vendedor',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['quotes.use'] as never,
  isSuperAdmin: false,
  ...overrides,
});
const approver = user({ id: 'u2', permissionKeys: ['quotes.approve'] as never });

const items = [
  { name: 'Tornillo M6', sku: 'T-M6', quantity: 3, unitPrice: 10.5, taxRate: 0.16 },
  { name: 'Tuerca', quantity: 2, unitPrice: 0.1, taxRate: 0 },
];

beforeEach(() => {
  db.current!.reset();
  audit.length = 0;
  saved.length = 0;
  books.impl = null;
});

describe('totals and hash', () => {
  it('computes totals with Decimal (no float drift)', () => {
    const t = computeTotals([{ name: 'x', quantity: 3, unitPrice: 0.1, taxRate: 0.16 }]);
    expect(t.subtotal).toBe('0.3000');
    expect(t.tax).toBe('0.0480');
    expect(t.total).toBe('0.3480');
  });

  it('hash is canonical (key order and number formatting do not matter)', () => {
    const a = computeQuoteContentHash({
      customerName: 'A',
      currency: 'MXN',
      items: [{ name: 'x', quantity: 1, unitPrice: 10, taxRate: 0 }],
    });
    const b = computeQuoteContentHash({
      items: [{ taxRate: 0, unitPrice: 10.0, quantity: 1.0, name: 'x' }],
      currency: 'MXN',
      customerName: 'A',
    });
    const c = computeQuoteContentHash({
      customerName: 'A',
      currency: 'MXN',
      items: [{ name: 'x', quantity: 1, unitPrice: 11, taxRate: 0 }],
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('drafting and versioning', () => {
  it('creates a draft with totals and rejects invalid items', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    expect(q.status).toBe('draft');
    expect(q.version).toBe(1);
    expect(q.subtotal).toBe('31.7000');
    expect(q.tax).toBe('5.0400');
    expect(q.total).toBe('36.7400');
    expect(q.contentHash).toHaveLength(64);
    await expect(
      createQuote(user(), {
        customerName: 'ACME',
        items: [{ name: 'x', quantity: 0, unitPrice: 1 }],
      })
    ).rejects.toThrow();
    await expect(
      createQuote(user({ permissionKeys: [] as never }), { customerName: 'ACME', items })
    ).rejects.toThrow(QuoteError);
  });

  it('a modified document invalidates the previous approval and pending proposals', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await requestApproval(user(), q.id);
    await db.current!.tables.aiProposal.create({
      data: {
        status: 'pending',
        toolName: 'approveOfficialQuote',
        args: { quoteId: q.id },
        fileIds: [],
      },
    });
    await db.current!.tables.aiProposal.create({
      data: { status: 'pending', toolName: 'sendWhatsApp', args: {}, fileIds: [q.id] },
    });
    await db.current!.tables.aiProposal.create({
      data: { status: 'pending', toolName: 'other', args: { quoteId: 'other' }, fileIds: [] },
    });

    const edited = await updateQuote(user(), q.id, { items: [{ ...items[0], unitPrice: 99 }] });
    expect(edited.status).toBe('draft');
    expect(edited.version).toBe(2);
    expect(edited.invalidationReason).toBe('Contenido modificado');
    expect(edited.contentHash).not.toBe(q.contentHash);
    const proposals = db.current!.tables.aiProposal.rows;
    expect(proposals.filter((p) => p.status === 'invalidated')).toHaveLength(2);
    expect(proposals.find((p) => p.toolName === 'other')?.status).toBe('pending');
    expect(audit.some((a) => a.action === 'quotes.approval_invalidated')).toBe(true);
  });

  it('an edit without material change keeps the version', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    const same = await updateQuote(user(), q.id, { customerName: 'ACME' });
    expect(same.version).toBe(1);
    expect(same.contentHash).toBe(q.contentHash);
  });
});

describe('approval', () => {
  it('fails when the reviewed hash differs from the current content', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await requestApproval(user(), q.id);
    await expect(
      approveQuote(approver, q.id, { expectedContentHash: 'deadbeefdeadbeef' })
    ).rejects.toMatchObject({ status: 409 });
    const row = await db.current!.tables.quote.findUnique({ where: { id: q.id } });
    expect(row?.status).toBe('pending_approval');
    expect(row?.zohoEstimateId).toBeNull();
  });

  it('requires quotes.approve and a pending quote', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await expect(
      approveQuote(user(), q.id, { expectedContentHash: q.contentHash! })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      approveQuote(approver, q.id, { expectedContentHash: q.contentHash! })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('creates the estimate in Books (mock) and marks the quote synced', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await requestApproval(user(), q.id);
    const res = await approveQuote(approver, q.id, { expectedContentHash: q.contentHash! });
    expect(res.uncertain).toBe(false);
    expect(res.books?.mock).toBe(true);
    expect(res.quote.status).toBe('synced');
    expect(res.quote.zohoEstimateId).toMatch(/^mock-/);
    expect(res.quote.approvedBy).toBe('u2');
    expect(audit.find((a) => a.action === 'quotes.approved')?.metadata).toMatchObject({
      mock: true,
    });
    // Second approval is refused: the estimate exists.
    await expect(
      approveQuote(approver, q.id, { expectedContentHash: q.contentHash! })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('an uncertain Books result leaves the quote pending with an explicit review note', async () => {
    books.impl = async () => ({ ok: false, uncertain: true, error: 'timeout' });
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await requestApproval(user(), q.id);
    const res = await approveQuote(approver, q.id, { expectedContentHash: q.contentHash! });
    expect(res.uncertain).toBe(true);
    expect(res.quote.status).toBe('pending_approval');
    expect(res.quote.invalidationReason).toMatch(/verificar en Books/i);
  });

  it('a Books rejection keeps the quote approved (retryable) and surfaces the error', async () => {
    books.impl = async () => ({ ok: false, uncertain: false, error: 'Customer not found' });
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await requestApproval(user(), q.id);
    await expect(
      approveQuote(approver, q.id, { expectedContentHash: q.contentHash! })
    ).rejects.toMatchObject({ status: 502 });
    const row = await db.current!.tables.quote.findUnique({ where: { id: q.id } });
    expect(row?.status).toBe('approved');
    expect(String(row?.invalidationReason)).toContain('Customer not found');
  });

  it('reject returns to rejected and invalidates proposals', async () => {
    const q = await createQuote(user(), { customerName: 'ACME', items });
    await requestApproval(user(), q.id);
    await db.current!.tables.aiProposal.create({
      data: {
        status: 'pending',
        toolName: 'approveOfficialQuote',
        args: { quoteId: q.id },
        fileIds: [],
      },
    });
    const rejected = await rejectQuote(approver, q.id, 'Precio fuera de política');
    expect(rejected.status).toBe('rejected');
    expect(db.current!.tables.aiProposal.rows[0].status).toBe('invalidated');
  });
});

describe('scenarios and package', () => {
  it('simulates scenarios without persisting', async () => {
    const q = await createQuote(user(), {
      customerName: 'ACME',
      items: [{ name: 'x', quantity: 10, unitPrice: 100, taxRate: 0.16 }],
    });
    const res = await simulateScenarios(user(), q.id, [
      { name: '10% desc', discountPct: 10 },
      { name: 'Doble', quantityMultiplier: 2 },
      { name: 'Sin IVA', taxRate: 0 },
    ]);
    expect(res.base.total).toBe('1160.0000');
    expect(res.scenarios[0].total).toBe('1044.0000');
    expect(res.scenarios[0].deltaPct).toBe('-10.00');
    expect(res.scenarios[1].total).toBe('2320.0000');
    expect(res.scenarios[2].total).toBe('1000.0000');
    const row = await db.current!.tables.quote.findUnique({ where: { id: q.id } });
    expect(new Prisma.Decimal(row!.total as never).toFixed(4)).toBe('1160.0000');
  });

  it('builds the commercial package with product cards, conditions and protected retention when approved', async () => {
    await db.current!.tables.product.create({
      data: {
        zohoItemId: 'z1',
        name: 'Tornillo M6',
        sku: 'T-M6',
        brand: 'Acme',
        unit: 'pza',
        satProductCode: '31161500',
      },
    });
    const q = await createQuote(user(), { customerName: 'ACME', items });
    const draftPkg = await buildCommercialPackage(user(), q.id);
    expect(draftPkg.products[0]).toMatchObject({
      found: true,
      brand: 'Acme',
      satProductCode: '31161500',
    });
    expect(draftPkg.products[1].found).toBe(false);
    expect(saved[0]).toMatchObject({
      purpose: 'document',
      retentionPolicy: 'default',
      restricted: true,
    });
    expect((saved[0].metadata as Record<string, unknown>).kind).toBe('quote_commercial_package');

    await requestApproval(user(), q.id);
    await approveQuote(approver, q.id, { expectedContentHash: q.contentHash! });
    const approvedPkg = await buildCommercialPackage(user(), q.id);
    expect(approvedPkg.protectedRetention).toBe(true);
    expect(saved[1]).toMatchObject({ retentionPolicy: 'protected' });
    const row = await db.current!.tables.quote.findUnique({ where: { id: q.id } });
    expect(row?.documentId).toBe(approvedPkg.documentId);
  });
});
