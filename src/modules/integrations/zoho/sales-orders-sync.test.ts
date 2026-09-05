import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Tests for the Zoho Sales Orders sync pipeline.
 *
 * These tests mock Prisma and the Zoho HTTP client to verify the pipeline
 * logic without contacting real services. They cover:
 *   - Pending records ordered by remoteModifiedAt DESC
 *   - New orders have priority over historical backlog
 *   - needsSync cleared after successful detail persist
 *   - Scan does not re-mark unchanged entities
 *   - 409 only while a run is active
 *   - Lock released on failure
 *   - Quick sync does not block HTTP
 *   - Full reconciliation still works
 */

// --- Mocks --------------------------------------------------------------

const mockPrismaClient = {
  integrationEntityState: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  integrationSnapshot: {
    upsert: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  integrationSyncRun: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  integrationConfig: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  integrationApiCall: {
    create: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    findMany: vi.fn(),
  },
  $transaction: vi.fn((args: unknown[]) => Promise.all(args)),
};

vi.mock('@/lib/prisma', () => ({
  prisma: mockPrismaClient,
}));

const mockListSalesOrders = vi.fn();
const mockGetSalesOrder = vi.fn();

vi.mock('@/modules/integrations/zoho/sales-orders', () => ({
  listSalesOrders: (...args: unknown[]) => mockListSalesOrders(...args),
  getSalesOrder: (...args: unknown[]) => mockGetSalesOrder(...args),
}));

vi.mock('@/modules/integrations/zoho/client', () => ({
  ZohoApiError: class ZohoApiError extends Error {
    constructor(
      message: string,
      public readonly operation: string,
      public readonly httpStatus?: number,
      public readonly zohoCode?: number
    ) {
      super(message);
      this.name = 'ZohoApiError';
    }
  },
}));

// The normalizer is dynamically imported inside the sync functions —
// mock it so tests don't need a real SalesOrder table.
vi.doMock('@/modules/sales/sales-orders-normalizer', () => ({
  normalizePendingSalesOrderSnapshots: vi
    .fn()
    .mockResolvedValue({ normalized: 0, skipped: 0 }),
}));

// --- Helpers ------------------------------------------------------------

function makeEntityState(opts: {
  id: string;
  externalId: string;
  remoteModifiedAt: Date;
  needsSync?: boolean;
  lastSyncedRemoteModifiedAt?: Date | null;
  lastDetailFetchedAt?: Date | null;
}) {
  return {
    id: opts.id,
    source: 'zoho',
    entityType: 'sales_order',
    externalId: opts.externalId,
    remoteModifiedAt: opts.remoteModifiedAt,
    lastSyncedRemoteModifiedAt: opts.lastSyncedRemoteModifiedAt ?? null,
    needsSync: opts.needsSync ?? true,
    lastSeenAt: new Date('2026-09-04T10:00:00Z'),
    lastDetailFetchedAt: opts.lastDetailFetchedAt ?? null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-04T10:00:00Z'),
  };
}

function makeZohoListResponse(orders: { id: string; modifiedAt: string }[], hasMore = false) {
  return {
    salesorders: orders.map((o) => ({
      salesorder_id: o.id,
      last_modified_time: o.modifiedAt,
    })),
    page_context: { has_more_page: hasMore },
  };
}

function makeZohoDetailResponse(id: string, modifiedAt: string) {
  return {
    code: 0,
    salesorder: {
      salesorder_id: id,
      last_modified_time: modifiedAt,
      salesorder_number: `OV-${id}`,
    },
  };
}

// Reset the in-memory lock between tests by manipulating globalThis.
function resetSyncLock() {
  (globalThis as unknown as Record<string, unknown>).__unikZohoSalesOrdersSyncLock = {
    inProgress: false,
  };
}

// --- Tests --------------------------------------------------------------

describe('Zoho Sales Orders sync pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSyncLock();

    // IntegrationConfig: return null so getIntegrationSettings seeds defaults,
    // and create returns a row with default settings.
    mockPrismaClient.integrationConfig.findUnique.mockResolvedValue(null);
    mockPrismaClient.integrationConfig.create.mockResolvedValue({
      id: 'cfg-1',
      source: 'zoho',
      displayName: 'Zoho Inventory',
      isEnabled: true,
      settings: {
        syncIntervalMs: 3_600_000,
        checkIntervalMs: 300_000,
        startupDelayMs: 30_000,
        schedulerMaxDetailFetches: 100,
        failedRetryCooldownMs: 1_800_000,
        quickScanPages: 2,
        quickMaxDetailFetches: 20,
        fullMaxDetailFetches: 50,
        recentThresholdMs: 86_400_000,
        perPage: 200,
        maxPages: 200,
        zohoRequestTimeoutMs: 30_000,
        prismaTimeoutMs: 15_000,
        quickSyncTimeoutMs: 180_000,
        scanSyncTimeoutMs: 300_000,
        fullSyncTimeoutMs: 900_000,
        staleRunThresholdMs: 600_000,
        schedulerEnabled: false,
      },
    });
    mockPrismaClient.integrationConfig.findMany.mockResolvedValue([]);
    mockPrismaClient.integrationConfig.update.mockResolvedValue({});
    mockPrismaClient.integrationApiCall.create.mockResolvedValue({});
  });

  describe('fetchPendingDetails ordering (FASE 2)', () => {
    it('queries pending entities ordered by remoteModifiedAt DESC with externalId ASC tiebreaker', async () => {
      // We verify the orderBy passed to findMany.
      // The sync function calls fetchPendingDetails internally.
      mockListSalesOrders.mockResolvedValue(makeZohoListResponse([], false));
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      await syncSalesOrders({ mode: 'sync', maxDetailFetches: 50 });

      const findManyCall = mockPrismaClient.integrationEntityState.findMany.mock.calls[0];
      expect(findManyCall[0].orderBy).toEqual([
        { remoteModifiedAt: 'desc' },
        { externalId: 'asc' },
      ]);
    });

    it('a new order (recent remoteModifiedAt) is processed before historical backlog', async () => {
      const recentDate = new Date('2026-09-04T12:00:00Z');
      const oldDate = new Date('2026-01-15T08:00:00Z');

      const recentEntity = makeEntityState({
        id: 'ent-recent',
        externalId: '23239',
        remoteModifiedAt: recentDate,
      });
      const oldEntity = makeEntityState({
        id: 'ent-old',
        externalId: '10001',
        remoteModifiedAt: oldDate,
      });

      // Simulate DB returning in DESC order (as the query specifies).
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([recentEntity, oldEntity]);

      mockGetSalesOrder.mockImplementation((id: string) =>
        Promise.resolve(
          makeZohoDetailResponse(
            id,
            id === '23239' ? '2026-09-04T12:00:00Z' : '2026-01-15T08:00:00Z'
          )
        )
      );

      mockPrismaClient.integrationSnapshot.upsert.mockResolvedValue({});
      mockPrismaClient.integrationEntityState.update.mockResolvedValue({});
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });
      mockListSalesOrders.mockResolvedValue(makeZohoListResponse([], false));

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await syncSalesOrders({ mode: 'sync', maxDetailFetches: 2 });

      // The recent order should be fetched first.
      expect(mockGetSalesOrder.mock.calls[0][0]).toBe('23239');
      expect(mockGetSalesOrder.mock.calls[1][0]).toBe('10001');
      expect(result.detailsFetched).toBe(2);
    });
  });

  describe('needsSync lifecycle (FASE 1 root cause)', () => {
    it('clears needsSync after successfully persisting detail', async () => {
      const entity = makeEntityState({
        id: 'ent-1',
        externalId: '123',
        remoteModifiedAt: new Date('2026-09-04T10:00:00Z'),
      });

      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([entity]);
      mockGetSalesOrder.mockResolvedValue(makeZohoDetailResponse('123', '2026-09-04T10:00:00Z'));
      mockPrismaClient.integrationSnapshot.upsert.mockResolvedValue({});
      mockPrismaClient.integrationEntityState.update.mockResolvedValue({});
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });
      mockListSalesOrders.mockResolvedValue(makeZohoListResponse([], false));

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      await syncSalesOrders({ mode: 'sync', maxDetailFetches: 1 });

      const updateCall = mockPrismaClient.integrationEntityState.update.mock.calls[0];
      expect(updateCall[0].data.needsSync).toBe(false);
      expect(updateCall[0].data.lastSyncedRemoteModifiedAt).toBeDefined();
    });

    it('scan does NOT re-mark an entity as needsSync when remoteModifiedAt is unchanged', async () => {
      const existingDate = new Date('2026-09-03T10:00:00Z');
      const existingEntity = makeEntityState({
        id: 'ent-1',
        externalId: '123',
        remoteModifiedAt: existingDate,
        needsSync: false,
        lastSyncedRemoteModifiedAt: existingDate,
      });

      mockPrismaClient.integrationEntityState.findUnique.mockResolvedValue(existingEntity);
      mockPrismaClient.integrationEntityState.update.mockResolvedValue({});
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      // Zoho returns the same last_modified_time.
      mockListSalesOrders.mockResolvedValue(
        makeZohoListResponse([{ id: '123', modifiedAt: '2026-09-03T10:00:00Z' }], false)
      );

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      await syncSalesOrders({ mode: 'scan' });

      const updateCall = mockPrismaClient.integrationEntityState.update.mock.calls[0];
      // Should only update lastSeenAt, NOT set needsSync or remoteModifiedAt.
      expect(updateCall[0].data).not.toHaveProperty('needsSync');
      expect(updateCall[0].data).not.toHaveProperty('remoteModifiedAt');
      expect(updateCall[0].data.lastSeenAt).toBeDefined();
    });

    it('scan DOES mark an entity as needsSync when remoteModifiedAt changes', async () => {
      const oldDate = new Date('2026-09-03T10:00:00Z');
      const newDate = new Date('2026-09-04T12:00:00Z');
      const existingEntity = makeEntityState({
        id: 'ent-1',
        externalId: '123',
        remoteModifiedAt: oldDate,
        needsSync: false,
        lastSyncedRemoteModifiedAt: oldDate,
      });

      mockPrismaClient.integrationEntityState.findUnique.mockResolvedValue(existingEntity);
      mockPrismaClient.integrationEntityState.update.mockResolvedValue({});
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      mockListSalesOrders.mockResolvedValue(
        makeZohoListResponse([{ id: '123', modifiedAt: '2026-09-04T12:00:00Z' }], false)
      );

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      await syncSalesOrders({ mode: 'scan' });

      const updateCall = mockPrismaClient.integrationEntityState.update.mock.calls[0];
      expect(updateCall[0].data.needsSync).toBe(true);
      expect(updateCall[0].data.remoteModifiedAt).toEqual(newDate);
    });
  });

  describe('Lock management (FASE 4)', () => {
    it('409 / SyncAlreadyRunningError only while a run is active', async () => {
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockListSalesOrders.mockResolvedValue(makeZohoListResponse([], false));

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      // Start a sync but don't await it — simulate lock held.
      const lock = (globalThis as unknown as Record<string, unknown>)
        .__unikZohoSalesOrdersSyncLock as {
        inProgress: boolean;
      };
      lock.inProgress = true;

      await expect(syncSalesOrders({ mode: 'sync' })).rejects.toThrow(
        'A sales orders sync is already running in this instance'
      );
    });

    it('lock is released when sync fails', async () => {
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });
      mockListSalesOrders.mockRejectedValue(new Error('Zoho down'));

      const { syncSalesOrders, SyncFailedError } =
        await import('@/modules/integrations/zoho/sales-orders-sync');

      await expect(syncSalesOrders({ mode: 'sync' })).rejects.toThrow(SyncFailedError);

      const lock = (globalThis as unknown as Record<string, unknown>)
        .__unikZohoSalesOrdersSyncLock as {
        inProgress: boolean;
      };
      expect(lock.inProgress).toBe(false);
    });
  });

  describe('Quick sync mode (FASE 3)', () => {
    it('quick sync scans only recent pages (not all pages)', async () => {
      let pagesCalled = 0;
      const seenIds: string[] = [];

      mockListSalesOrders.mockImplementation((opts?: { page?: number; sortColumn?: string }) => {
        pagesCalled++;
        const page = opts?.page ?? 1;
        if (page === 1) {
          return Promise.resolve(
            makeZohoListResponse(
              [
                { id: '23239', modifiedAt: new Date().toISOString() },
                { id: '23238', modifiedAt: new Date(Date.now() - 3600_000).toISOString() },
              ],
              true
            )
          );
        }
        if (page === 2) {
          return Promise.resolve(
            makeZohoListResponse(
              [{ id: '23237', modifiedAt: new Date(Date.now() - 7200_000).toISOString() }],
              false
            )
          );
        }
        return Promise.resolve(makeZohoListResponse([], false));
      });

      mockPrismaClient.integrationEntityState.findUnique.mockImplementation(() => {
        return Promise.resolve(null);
      });
      mockPrismaClient.integrationEntityState.create.mockImplementation(
        (args: { data: { externalId: string } }) => {
          seenIds.push(args.data.externalId);
          return Promise.resolve({ id: 'ent-' + args.data.externalId });
        }
      );
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await syncSalesOrders({ mode: 'quick', maxDetailFetches: 50 });

      // Sorted pass finds recent records on page 1, continues to page 2.
      expect(pagesCalled).toBe(2);
      expect(result.pagesScanned).toBe(2);
      expect(result.recordsSeen).toBe(3);
      expect(seenIds).toContain('23239');
    });

    it('quick sync passes sortColumn=last_modified_time and sortOrder=D to Zoho', async () => {
      let capturedQuery: Record<string, string> | undefined;
      mockListSalesOrders.mockImplementation(
        (opts?: { page?: number; sortColumn?: string; sortOrder?: string }) => {
          capturedQuery = {
            sortColumn: opts?.sortColumn ?? '',
            sortOrder: opts?.sortOrder ?? '',
          };
          // Return a recent record so Pass 1 finds something and stops.
          return Promise.resolve(
            makeZohoListResponse([{ id: '999', modifiedAt: new Date().toISOString() }], false)
          );
        }
      );
      mockPrismaClient.integrationEntityState.findUnique.mockResolvedValue(null);
      mockPrismaClient.integrationEntityState.create.mockResolvedValue({ id: 'ent-999' });
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      await syncSalesOrders({ mode: 'quick' });

      expect(capturedQuery?.sortColumn).toBe('last_modified_time');
      expect(capturedQuery?.sortOrder).toBe('D');
    });

    it('quick sync falls back to unsorted scan if sorted scan fails with ZohoApiError', async () => {
      const { ZohoApiError } = await import('@/modules/integrations/zoho/client');
      let calls = 0;
      mockListSalesOrders.mockImplementation((opts?: { page?: number; sortColumn?: string }) => {
        calls++;
        if (opts?.sortColumn) {
          // Simulate Zoho rejecting the sort params.
          return Promise.reject(new ZohoApiError('Invalid sort_order', 'GET /salesorders', 400));
        }
        return Promise.resolve(
          makeZohoListResponse([{ id: '999', modifiedAt: new Date().toISOString() }], false)
        );
      });
      mockPrismaClient.integrationEntityState.findUnique.mockResolvedValue(null);
      mockPrismaClient.integrationEntityState.create.mockResolvedValue({ id: 'ent-999' });
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await syncSalesOrders({ mode: 'quick' });

      // Pass 1: sorted page 1 fails → break. Pass 2: unsorted page 1 succeeds, recent found.
      expect(calls).toBe(2);
      expect(result.recordsSeen).toBe(1);
    });

    it('quick sync scans last pages when first pages have only old records', async () => {
      const oldDate = '2020-01-01T00:00:00Z';
      let calls = 0;

      mockListSalesOrders.mockImplementation((opts?: { page?: number; sortColumn?: string }) => {
        calls++;
        const page = opts?.page ?? 1;
        const sorted = opts?.sortColumn !== undefined;

        if (sorted) {
          // Sorted scan returns old records (sort_order=D ignored → ascending).
          return Promise.resolve(
            makeZohoListResponse([{ id: 'old-' + page, modifiedAt: oldDate }], page < 3)
          );
        }

        if (page <= 3) {
          // Unsorted scan also returns old records.
          return Promise.resolve(
            makeZohoListResponse([{ id: 'old-unsorted-' + page, modifiedAt: oldDate }], true)
          );
        }

        // Last pages return recent records.
        return Promise.resolve(
          makeZohoListResponse([{ id: 'new-' + page, modifiedAt: new Date().toISOString() }], false)
        );
      });

      mockPrismaClient.integrationEntityState.findUnique.mockResolvedValue(null);
      mockPrismaClient.integrationEntityState.create.mockResolvedValue({ id: 'ent' });
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(1000);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await syncSalesOrders({ mode: 'quick' });

      // Pass 1: 2 sorted pages (all old). Pass 2: 2 unsorted pages (all old).
      // Pass 3: scans last 2 pages (page 5 for 1000 entities / 200 per page) — finds recent.
      expect(calls).toBeGreaterThanOrEqual(5);
      expect(result.recordsSeen).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Full reconciliation (FASE 3)', () => {
    it('full sync mode walks all pages', async () => {
      let pagesCalled = 0;

      mockListSalesOrders.mockImplementation((opts?: { page?: number; sortColumn?: string }) => {
        pagesCalled++;
        const page = opts?.page ?? 1;
        // Full sync should NOT pass sortColumn.
        expect(opts?.sortColumn).toBeUndefined();
        if (page <= 3) {
          return Promise.resolve(
            makeZohoListResponse(
              [{ id: String(page), modifiedAt: '2026-09-04T10:00:00Z' }],
              page < 3
            )
          );
        }
        return Promise.resolve(makeZohoListResponse([], false));
      });

      mockPrismaClient.integrationEntityState.findUnique.mockResolvedValue(null);
      mockPrismaClient.integrationEntityState.create.mockResolvedValue({ id: 'ent' });
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { syncSalesOrders } = await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await syncSalesOrders({ mode: 'sync', maxDetailFetches: 50 });

      expect(pagesCalled).toBe(3);
      expect(result.pagesScanned).toBe(3);
    });
  });

  describe('Background sync / startSyncSalesOrders (FASE 4)', () => {
    it('startSyncSalesOrders returns immediately with a run ID (non-blocking)', async () => {
      mockPrismaClient.integrationSyncRun.create.mockResolvedValue({ id: 'run-bg-1' });
      mockPrismaClient.integrationSyncRun.findFirst.mockResolvedValue(null);
      mockPrismaClient.integrationSyncRun.updateMany.mockResolvedValue({ count: 0 });
      mockListSalesOrders.mockResolvedValue(makeZohoListResponse([], false));
      mockPrismaClient.integrationEntityState.findMany.mockResolvedValue([]);
      mockPrismaClient.integrationEntityState.count.mockResolvedValue(0);
      mockPrismaClient.integrationSyncRun.update.mockResolvedValue({});
      mockPrismaClient.integrationSyncRun.findUnique.mockResolvedValue({ status: 'RUNNING' });

      const { startSyncSalesOrders } =
        await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await startSyncSalesOrders({ mode: 'quick', maxDetailFetches: 50 });

      expect(result.runId).toBe('run-bg-1');
      expect(result.alreadyRunning).toBe(false);

      // The lock should be held (background sync is running).
      const lock = (globalThis as unknown as Record<string, unknown>)
        .__unikZohoSalesOrdersSyncLock as {
        inProgress: boolean;
      };
      expect(lock.inProgress).toBe(true);
    });

    it('startSyncSalesOrders returns alreadyRunning=true when lock is held', async () => {
      mockPrismaClient.integrationSyncRun.findFirst.mockResolvedValue({
        id: 'run-existing',
        mode: 'quick',
        status: 'RUNNING',
        startedAt: new Date(),
        completedAt: null,
        pagesScanned: 0,
        recordsSeen: 0,
        recordsPending: 0,
        detailsFetched: 0,
        detailsFailed: 0,
        apiCalls: 0,
        errorCode: null,
      });
      mockPrismaClient.integrationSyncRun.updateMany.mockResolvedValue({ count: 0 });

      const lock = (globalThis as unknown as Record<string, unknown>)
        .__unikZohoSalesOrdersSyncLock as {
        inProgress: boolean;
      };
      lock.inProgress = true;

      const { startSyncSalesOrders } =
        await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await startSyncSalesOrders({ mode: 'quick' });

      expect(result.alreadyRunning).toBe(true);
      expect(result.runId).toBe('run-existing');
    });
  });

  describe('Stale run cleanup (FASE 4)', () => {
    it('getActiveSyncRun marks stale RUNNING runs as FAILED', async () => {
      const staleDate = new Date(Date.now() - 15 * 60 * 1000); // 15 min ago
      mockPrismaClient.integrationSyncRun.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaClient.integrationSyncRun.findFirst.mockResolvedValue(null);

      const { getActiveSyncRun } = await import('@/modules/integrations/zoho/sales-orders-sync');

      const result = await getActiveSyncRun();

      expect(result).toBeNull();
      expect(mockPrismaClient.integrationSyncRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'RUNNING',
            startedAt: { lt: expect.any(Date) },
          }),
          data: expect.objectContaining({
            status: 'FAILED',
          }),
        })
      );
      void staleDate;
    });
  });
});
