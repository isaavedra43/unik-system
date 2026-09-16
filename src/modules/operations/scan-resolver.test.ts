import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/inventory/inventory-queries', () => ({ scanStockCode: vi.fn() }));

import { scanStockCode } from '@/modules/inventory/inventory-queries';
import type { ScanResolution, ScannedStockItem } from '@/modules/inventory/labels-service';
import { AREA_REGISTRY, areaHref } from '@/modules/areas/area-registry';
import { makeCurrentUser } from './testing/fixtures';
import {
  INVENTORY_SCAN_PATH,
  SCAN_MAX_ITEMS,
  describeScan,
  lookupScan,
  normalizeScanCode,
} from './scan-resolver';

/**
 * The scan answer the mobile bar shows. `describeScan` is pure, so the whole
 * shape is checked here; the lookup only proves it delegates to the inventory
 * module (the one that checks permissions and reads stock).
 */

function stockItem(overrides: Partial<ScannedStockItem> = {}): ScannedStockItem {
  return {
    id: 'si-1',
    zohoItemId: 'z-1',
    productName: 'Placa de acero 3/8"',
    sku: 'PL-ACERO-38',
    warehouseId: 'wh-1',
    locationId: 'loc-1',
    locationCode: 'A-01-02',
    variantKey: 'w=1200|l=2400',
    variantLabel: '1200 × 2400',
    containerKey: 'PL-000045',
    known: '4',
    available: '3.5',
    baseUnit: 'pza',
    confidence: 'CONTROLLED',
    label: { code: 'PL-000045', qr: 'unik:stock:si-1', title: '', subtitle: '', lines: [] },
    ...overrides,
  };
}

describe('normalizeScanCode', () => {
  it('trims and clips', () => {
    expect(normalizeScanCode('  A-01-02  ')).toBe('A-01-02');
    expect(normalizeScanCode('x'.repeat(500))).toHaveLength(200);
  });

  it('answers empty for anything that is not a string', () => {
    expect(normalizeScanCode(null)).toBe('');
    expect(normalizeScanCode(42)).toBe('');
    expect(normalizeScanCode(undefined)).toBe('');
  });
});

describe('describeScan', () => {
  it('describes one stock item with its location and confidence', () => {
    const lookup = describeScan({ kind: 'stock_item', stockItem: stockItem() }, 'PL-000045');
    expect(lookup.kind).toBe('stock_item');
    expect(lookup.title).toBe('Placa de acero 3/8"');
    expect(lookup.subtitle).toContain('SKU PL-ACERO-38');
    expect(lookup.subtitle).toContain('Ubicación A-01-02');
    expect(lookup.subtitle).toContain('Controlado');
    expect(lookup.items).toHaveLength(1);
    expect(lookup.items[0].quantity).toBe('3.5');
    expect(lookup.items[0].unit).toBe('pza');
    expect(lookup.message).toBeNull();
    expect(lookup.href).toBe(`${INVENTORY_SCAN_PATH}?scan=PL-000045`);
  });

  it('falls back to the SKU and then to the container when there is no product name', () => {
    const noName = describeScan(
      { kind: 'stock_item', stockItem: stockItem({ productName: null }) },
      'x'
    );
    expect(noName.title).toBe('PL-ACERO-38');
    const noSku = describeScan(
      { kind: 'stock_item', stockItem: stockItem({ productName: null, sku: null }) },
      'x'
    );
    expect(noSku.title).toBe('PL-000045');
  });

  it('describes a location with its rows', () => {
    const resolution: ScanResolution = {
      kind: 'location',
      location: {
        id: 'loc-1',
        warehouseId: 'wh-1',
        code: 'A-01-02',
        label: 'Rack norte',
        active: true,
      },
      stockItems: [stockItem(), stockItem({ id: 'si-2' })],
    };
    const lookup = describeScan(resolution, 'unik:loc:loc-1');
    expect(lookup.kind).toBe('location');
    expect(lookup.title).toBe('Ubicación A-01-02');
    expect(lookup.subtitle).toBe('Rack norte · 2 registros de existencia');
    expect(lookup.items).toHaveLength(2);
    expect(lookup.href).toBe(`${INVENTORY_SCAN_PATH}?scan=${encodeURIComponent('unik:loc:loc-1')}`);
  });

  it('says so in singular and when a location is empty', () => {
    const empty = describeScan(
      {
        kind: 'location',
        location: { id: 'l', warehouseId: 'w', code: 'B-02', label: null, active: true },
        stockItems: [],
      },
      'B-02'
    );
    expect(empty.subtitle).toBe('Sin existencias registradas');
    const one = describeScan(
      {
        kind: 'location',
        location: { id: 'l', warehouseId: 'w', code: 'B-02', label: null, active: true },
        stockItems: [stockItem()],
      },
      'B-02'
    );
    expect(one.subtitle).toBe('1 registro de existencia');
  });

  it('caps the rows it returns and announces the rest', () => {
    const rows = Array.from({ length: SCAN_MAX_ITEMS + 5 }, (_, index) =>
      stockItem({ id: `si-${index}` })
    );
    const lookup = describeScan(
      {
        kind: 'sku',
        product: { zohoItemId: 'z-1', name: 'Placa', sku: 'PL', unit: 'pza' },
        stockItems: rows,
      },
      'PL'
    );
    expect(lookup.items).toHaveLength(SCAN_MAX_ITEMS);
    expect(lookup.moreItems).toBe(5);
    expect(lookup.subtitle).toBe('SKU PL · 25 registros de existencia');
  });

  it('explains an unknown code without echoing it as an instruction', () => {
    const lookup = describeScan({ kind: 'unknown', text: 'hola' }, 'hola');
    expect(lookup.kind).toBe('unknown');
    expect(lookup.items).toHaveLength(0);
    expect(lookup.href).toBeNull();
    expect(lookup.subtitle).toBe('Leímos "hola"');
    expect(lookup.message).toContain('Revisa el código');
  });

  it('handles an empty scan', () => {
    const lookup = describeScan({ kind: 'unknown', text: '' }, '');
    expect(lookup.subtitle).toBe('No leímos nada');
    expect(lookup.message).toBe('Escanea una etiqueta o escribe el código.');
  });

  it('keeps a quantity that is not a number as it came', () => {
    const lookup = describeScan(
      { kind: 'stock_item', stockItem: stockItem({ available: 'n/d' }) },
      'x'
    );
    expect(lookup.items[0].quantity).toBe('n/d');
  });
});

describe('the deep link matches the area registry', () => {
  it('points at the real inventory map space', () => {
    expect(INVENTORY_SCAN_PATH).toBe(areaHref('inventario', AREA_REGISTRY.inventario.special.slug));
  });
});

describe('lookupScan', () => {
  it('delegates to the inventory module (which checks the permissions)', async () => {
    vi.mocked(scanStockCode).mockResolvedValue({ kind: 'unknown', text: 'A-01' });
    const user = makeCurrentUser({ id: 'u-1', permissionKeys: ['inventory.view'] });
    const lookup = await lookupScan(user, '  A-01  ', { warehouseId: 'wh-1' });
    expect(scanStockCode).toHaveBeenCalledWith(user, 'A-01', { warehouseId: 'wh-1' });
    expect(lookup.code).toBe('A-01');
    expect(lookup.kind).toBe('unknown');
  });
});
