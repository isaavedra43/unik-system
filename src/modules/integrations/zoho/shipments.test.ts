import { describe, expect, it } from 'vitest';
import { extractPackageLineItems, extractShipmentOrder } from './shipments';
import { shipmentInputSchema } from '@/modules/packages/packages-shipping-service';

describe('shipments client helpers', () => {
  it('reads the shipment order from either envelope key', () => {
    expect(extractShipmentOrder({ shipment_order: { shipment_id: 123, shipment_number: 'NE-1', status: 'shipped' } })).toEqual({ shipment_id: '123', shipment_number: 'NE-1', status: 'shipped' });
    expect(extractShipmentOrder({ shipmentorder: { shipment_id: '9' } })).toEqual({ shipment_id: '9', shipment_number: undefined, status: undefined });
    expect(extractShipmentOrder({ code: 0 })).toBeNull();
  });

  it('keeps line ids and quantities of the package for updates', () => {
    expect(extractPackageLineItems({ package: { line_items: [{ line_item_id: 1, so_line_item_id: 2, quantity: '3' }, { name: 'sin id' }] } })).toEqual([
      { line_item_id: '1', so_line_item_id: '2', quantity: 3 },
    ]);
    expect(extractPackageLineItems(null)).toEqual([]);
  });
});

describe('shipmentInputSchema', () => {
  it('requires carrier and date, tolerates empty optionals', () => {
    const ok = shipmentInputSchema.parse({ carrier: ' CHUY ', date: '2026-09-14', trackingNumber: '', trackingUrl: '', shippingCharge: '', notes: '' });
    expect(ok.carrier).toBe('CHUY');
    expect(ok.delivered).toBe(false);
    expect(() => shipmentInputSchema.parse({ carrier: '', date: '2026-09-14' })).toThrow();
    expect(() => shipmentInputSchema.parse({ carrier: 'X', date: '14/09/2026' })).toThrow();
  });
});
