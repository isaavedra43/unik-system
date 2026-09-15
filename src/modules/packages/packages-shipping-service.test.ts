import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterization of shipPackage (asignar transportista / orden de envío):
 * - ZOHO_BOOKS_MOCK=true: nothing is sent to Zoho, the change is simulated in the DB;
 * - Zoho mode: create or update the shipment order, then re-read the package with
 *   refreshPackageOnDemand({ force: true }); when the read-back can't happen, patch locally;
 * - Zoho errors surface as PackageShippingError with an HTTP status for the route.
 * Prisma, the Zoho write calls, the read-back and the audit log are mocked.
 */

const { db, zoho, readBack, audit, packages } = vi.hoisted(() => ({
  db: {
    package: {
      findUnique: vi.fn(),
      update: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({})),
    },
    integrationSnapshot: { findFirst: vi.fn(async () => null) },
  },
  zoho: {
    createShipmentOrder: vi.fn(),
    updateShipmentOrder: vi.fn(),
    markShipmentDelivered: vi.fn(async () => ({ code: 0 })),
    deleteShipmentOrder: vi.fn(),
    updatePackage: vi.fn(),
  },
  readBack: vi.fn(),
  audit: vi.fn(async () => undefined),
  packages: { getPackageById: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/modules/integrations/zoho/shipments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/integrations/zoho/shipments')>();
  return { ...actual, ...zoho };
});
vi.mock('@/modules/integrations/zoho/packages-shipment-sweep', () => ({
  refreshPackageOnDemand: readBack,
}));
vi.mock('@/modules/integrations/zoho/packages-sync', () => ({ PACKAGES_ENTITY_TYPE: 'package' }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: audit }));
vi.mock('./packages-service', () => packages);

import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { PackageShippingError, shipPackage } from './packages-shipping-service';

const actor = { id: 'user-1' };
const PKG_ID = 'pkg-1';

const storedPackage = (overrides: Record<string, unknown> = {}) => ({
  id: PKG_ID,
  zohoPackageId: '4600000100',
  zohoSalesOrderId: '4600000200',
  zohoShipmentId: null,
  shipmentNumber: null,
  packageNumber: 'PKG-27622',
  status: 'not_shipped',
  date: new Date('2026-09-10T00:00:00.000Z'),
  ...overrides,
});

const input = {
  carrier: 'Paquetexpress',
  date: '2026-09-15',
  trackingNumber: 'PX123',
  trackingUrl: '',
  shippingCharge: 250,
  notes: 'Entregar en andén 2',
};

const detail = {
  id: PKG_ID,
  zohoSalesOrderId: '4600000200',
  zohoCustomerId: '4600000300',
  status: 'shipped',
};

beforeEach(() => {
  vi.clearAllMocks();
  db.package.findUnique.mockResolvedValue(storedPackage());
  packages.getPackageById.mockResolvedValue(detail);
  zoho.createShipmentOrder.mockResolvedValue({
    code: 0,
    shipment_order: { shipment_id: '4600000999', shipment_number: 'NE-28815' },
  });
  zoho.updateShipmentOrder.mockResolvedValue({
    code: 0,
    shipment_order: { shipment_id: '4600000777', shipment_number: 'NE-00001' },
  });
  readBack.mockResolvedValue({ status: 'refreshed', at: new Date() });
  vi.stubEnv('ZOHO_BOOKS_MOCK', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shipPackage — ZOHO_BOOKS_MOCK=true', () => {
  it('simulates the shipment in the DB without calling Zoho or re-reading', async () => {
    vi.stubEnv('ZOHO_BOOKS_MOCK', 'true');

    const result = await shipPackage(actor, PKG_ID, input);

    expect(result).toBe(detail);
    expect(zoho.createShipmentOrder).not.toHaveBeenCalled();
    expect(zoho.updateShipmentOrder).not.toHaveBeenCalled();
    expect(readBack).not.toHaveBeenCalled();
    expect(db.package.update).toHaveBeenCalledTimes(1);
    const { where, data } = db.package.update.mock.calls[0][0] as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(where).toEqual({ id: PKG_ID });
    expect(data).toMatchObject({
      carrier: 'Paquetexpress',
      deliveryMethod: 'Paquetexpress',
      trackingNumber: 'PX123',
      trackingUrl: null,
      shippingCharge: 250,
      status: 'shipped',
      shipmentStatus: 'shipped',
      shipmentNumber: 'NE-MOCK-PKG-27622',
      deliveryDate: null,
    });
    expect(String(data.zohoShipmentId)).toMatch(/^mock-\d+$/);
    expect(data.shipmentDate).toEqual(new Date('2026-09-15T00:00:00.000Z'));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'packages.shipped',
        targetId: PKG_ID,
        metadata: expect.objectContaining({ source: 'mock' }),
      })
    );
  });
});

describe('shipPackage — Zoho', () => {
  it('creates the shipment order, then re-reads the package with force and does not patch locally', async () => {
    await shipPackage(actor, PKG_ID, input);

    expect(zoho.createShipmentOrder).toHaveBeenCalledWith({
      packageId: '4600000100',
      salesOrderId: '4600000200',
      input: {
        date: '2026-09-15',
        delivery_method: 'Paquetexpress',
        tracking_number: 'PX123',
        tracking_url: undefined,
        shipping_charge: 250,
        notes: 'Entregar en andén 2',
      },
    });
    expect(zoho.updateShipmentOrder).not.toHaveBeenCalled();
    expect(readBack).toHaveBeenCalledWith(PKG_ID, { force: true });
    expect(db.package.update).not.toHaveBeenCalled();
    expect(zoho.markShipmentDelivered).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'packages.shipped',
        metadata: expect.objectContaining({ zohoShipmentId: '4600000999', source: 'zoho' }),
      })
    );
    expect(packages.getPackageById).toHaveBeenCalledWith(PKG_ID);
  });

  it('updates the existing shipment order when the package was already shipped', async () => {
    db.package.findUnique.mockResolvedValue(
      storedPackage({ zohoShipmentId: '4600000777', shipmentNumber: 'NE-00001', status: 'shipped' })
    );

    await shipPackage(actor, PKG_ID, input);

    expect(zoho.createShipmentOrder).not.toHaveBeenCalled();
    expect(zoho.updateShipmentOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        shipmentId: '4600000777',
        packageId: '4600000100',
        salesOrderId: '4600000200',
      })
    );
    expect(readBack).toHaveBeenCalledWith(PKG_ID, { force: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'packages.shipment_updated' })
    );
  });

  it('marks the shipment delivered in Zoho when the form says it was already delivered', async () => {
    await shipPackage(actor, PKG_ID, { ...input, delivered: true, deliveryDate: '2026-09-16' });

    expect(zoho.markShipmentDelivered).toHaveBeenCalledWith('4600000999', '2026-09-16');
    expect(readBack).toHaveBeenCalledWith(PKG_ID, { force: true });
  });

  it('patches locally and flags the row for the sweep when the read-back cannot run now', async () => {
    readBack.mockResolvedValue({ status: 'busy' });

    await shipPackage(actor, PKG_ID, input);

    expect(readBack).toHaveBeenCalledWith(PKG_ID, { force: true });
    expect(db.package.update).toHaveBeenCalledTimes(1);
    const { data } = db.package.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      zohoShipmentId: '4600000999',
      shipmentNumber: 'NE-28815',
      status: 'shipped',
      lastDetailFetchedAt: null,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ source: 'local' }) })
    );
  });
});

describe('shipPackage — errors', () => {
  it('turns a Zoho API error into PackageShippingError 502 with the Zoho message, and writes nothing', async () => {
    zoho.createShipmentOrder.mockRejectedValue(
      new ZohoApiError(
        'Zoho request failed',
        'POST /shipmentorders',
        400,
        36004,
        'El paquete ya fue enviado'
      )
    );

    const attempt = shipPackage(actor, PKG_ID, input);
    await expect(attempt).rejects.toBeInstanceOf(PackageShippingError);
    await expect(attempt).rejects.toMatchObject({
      status: 502,
      message: 'No se pudo crear la orden de envío en Zoho: El paquete ya fue enviado',
    });
    expect(readBack).not.toHaveBeenCalled();
    expect(db.package.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('adds the auto-numbering hint when Zoho complains about the shipment number', async () => {
    zoho.updateShipmentOrder.mockRejectedValue(
      new ZohoApiError(
        'Zoho request failed',
        'PUT /shipmentorders',
        400,
        4,
        'shipment_number is required'
      )
    );
    db.package.findUnique.mockResolvedValue(storedPackage({ zohoShipmentId: '4600000777' }));

    await expect(shipPackage(actor, PKG_ID, input)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining(
        'No se pudo actualizar la orden de envío en Zoho: shipment_number is required Activa la numeración automática'
      ),
    });
  });

  it('reports missing Zoho credentials as 503', async () => {
    zoho.createShipmentOrder.mockRejectedValue(
      new Error('Invalid or missing Zoho environment variables: ZOHO_CLIENT_ID')
    );

    const attempt = shipPackage(actor, PKG_ID, input);
    await expect(attempt).rejects.toBeInstanceOf(PackageShippingError);
    await expect(attempt).rejects.toMatchObject({
      status: 503,
      message: 'Faltan credenciales de Zoho en el servidor.',
    });
  });

  it('rejects before calling Zoho when the package has no sales order or does not exist', async () => {
    db.package.findUnique.mockResolvedValueOnce(storedPackage({ zohoSalesOrderId: null }));
    await expect(shipPackage(actor, PKG_ID, input)).rejects.toMatchObject({
      name: 'PackageShippingError',
      status: 409,
    });

    db.package.findUnique.mockResolvedValueOnce(null);
    await expect(shipPackage(actor, PKG_ID, input)).rejects.toMatchObject({
      name: 'PackageShippingError',
      status: 404,
    });

    expect(zoho.createShipmentOrder).not.toHaveBeenCalled();
  });

  it('validates the input before touching the DB or Zoho', async () => {
    await expect(shipPackage(actor, PKG_ID, { ...input, carrier: '' })).rejects.toMatchObject({
      name: 'ZodError',
    });
    expect(db.package.findUnique).not.toHaveBeenCalled();
    expect(zoho.createShipmentOrder).not.toHaveBeenCalled();
  });
});
