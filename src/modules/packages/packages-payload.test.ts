import { describe, expect, it } from 'vitest';
import { extractZohoPackage, mapZohoPackage } from './packages-payload';

/** Shape of Zoho Inventory `GET /packages/{id}` once the package has shipped. */
const detail = {
  code: 0,
  message: 'success',
  package: {
    package_id: '4459650000034015929',
    package_number: 'PKG-27622',
    salesorder_id: '4459650000034015001',
    salesorder_number: 'OV-23322',
    shipment_id: '4459650000034016100',
    customer_id: '4459650000000123456',
    customer_name: 'HUMBERTO MONTOYA',
    status: 'shipped',
    detailed_status: 'shipped',
    date: '2026-09-09',
    shipment_date: '2026-09-11',
    carrier: '',
    tracking_number: '',
    shipping_charge: 0,
    shipment_order: {
      shipment_id: '4459650000034016100',
      shipment_number: 'NE-28815',
      shipment_date: '2026-09-11',
      carrier: 'GERARDO ORTIZ',
      service: '',
      tracking_number: '',
      status: 'shipped',
      delivery_date: '',
      notes: 'Entregar en obra',
    },
    shipping_address: {
      attention: '',
      address: 'Punta del marqués 188',
      street2: 'Punta del este',
      city: 'León',
      state: 'Guanajuato',
      zip: '37690',
      country: 'Mexico',
      phone: '4771607576',
    },
    line_items: [
      {
        line_item_id: '1',
        item_id: 11111605,
        sku: '1111160',
        name: 'Marmol Fiorito a la Veta Natural 30xLLx1',
        description: '',
        quantity: 45,
        unit: 'm2',
        item_order: 0,
      },
    ],
    last_modified_time: '2026-09-11T13:08:00-0600',
  },
};

describe('mapZohoPackage', () => {
  it('reads the carrier and shipment data from shipment_order when the package fields are empty', () => {
    const extracted = extractZohoPackage(detail);
    expect(extracted.error).toBeNull();
    const mapped = mapZohoPackage(extracted.data!);

    expect(mapped.zohoPackageId).toBe('4459650000034015929');
    expect(mapped.carrier).toBe('GERARDO ORTIZ');
    expect(mapped.shipmentNumber).toBe('NE-28815');
    expect(mapped.zohoShipmentId).toBe('4459650000034016100');
    expect(mapped.shipmentDate?.toISOString().slice(0, 10)).toBe('2026-09-11');
    expect(mapped.deliveryDate).toBeNull();
    expect(mapped.trackingNumber).toBeNull();
    expect(mapped.notes).toBe('Entregar en obra');
  });

  it('flattens the shipping_address object and reads line_items', () => {
    const mapped = mapZohoPackage(extractZohoPackage(detail).data!);
    expect(mapped.shippingAddress).toBe('Punta del marqués 188, Punta del este');
    expect(mapped.shippingCity).toBe('León');
    expect(mapped.shippingPhone).toBe('4771607576');
    expect(mapped.items).toEqual([
      {
        zohoItemId: '11111605',
        name: 'Marmol Fiorito a la Veta Natural 30xLLx1',
        sku: '1111160',
        description: null,
        quantity: '45',
        unit: 'm2',
        sortOrder: 0,
      },
    ]);
    expect(mapped.quantity).toBe('45');
  });

  it('still accepts the flat LIST record', () => {
    const list = {
      package_id: '1',
      package_number: 'PKG-00001',
      status: 'not_shipped',
      date: '2026-09-01',
      carrier: 'DHL',
      customer_name: 'Cliente',
      shipping_address: 'Calle 1',
      quantity: '2.00',
    };
    const mapped = mapZohoPackage(extractZohoPackage(list).data!);
    expect(mapped.carrier).toBe('DHL');
    expect(mapped.shippingAddress).toBe('Calle 1');
    expect(mapped.items).toEqual([]);
    expect(mapped.quantity).toBe('2.00');
  });

  it('rejects envelopes with a Zoho error code', () => {
    expect(extractZohoPackage({ code: 1002, message: 'not found' }).error).toMatch(/1002/);
    expect(extractZohoPackage({ code: 0, package: { name: 'x' } }).data).toBeNull();
  });
});
