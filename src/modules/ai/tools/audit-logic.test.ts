import { describe, it, expect } from 'vitest';
import { matchesDeliveryMethod, matchesDeliveryType, matchesLocation } from './ai-filter-matching';
import { applySalesOrderFilters } from './sales-order-ai-filters';
import { auditPendingDelivery, paymentCategory, reconcileCashClose, summarizeProductRelations } from './audit-logic';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const today = d('2026-09-11');
const codes = (flags: Array<{ code: string }>) => flags.map((f) => f.code);

describe('delivery inference', () => {
  it('"a domicilio" means anything delivered to the customer, not pickups', () => {
    expect(matchesDeliveryMethod('A PIE DE OBRA (LIBRE DE MANIOBRAS)', 'a domicilio')).toBe(true);
    expect(matchesDeliveryMethod('INSTALACIÓN A DOMICILIO', 'a domicilio')).toBe(true);
    expect(matchesDeliveryMethod('RECOGE EN BODEGA', 'a domicilio')).toBe(false);
  });

  it('delivery types', () => {
    expect(matchesDeliveryType('RECOGE EN BODEGA', 'recoge_en_bodega')).toBe(true);
    expect(matchesDeliveryType('A PIE DE OBRA (LIBRE DE MANIOBRAS)', 'recoge_en_bodega')).toBe(false);
    expect(matchesDeliveryType('A PIE DE OBRA (LIBRE DE MANIOBRAS)', 'pie_de_obra')).toBe(true);
    expect(matchesDeliveryType('INSTALACIÓN A DOMICILIO', 'pie_de_obra')).toBe(false);
  });

  it('specific names still match literally', () => {
    expect(matchesDeliveryMethod('INSTALACIÓN A DOMICILIO', 'instalacion a domicilio')).toBe(true);
    expect(matchesDeliveryMethod('INSTALACIÓN A DOMICILIO', 'pie de obra')).toBe(false);
  });
});

describe('matchesLocation', () => {
  it('matches the state name written in the address', () => {
    expect(matchesLocation(['TONALA JALISCO (PEDIR UBICACION)'], 'Jalisco')).toBe(true);
  });

  it('matches by abbreviation and main cities', () => {
    expect(matchesLocation(['Col. San Juan Bosco', 'León', 'Gto.'], 'guanajuato')).toBe(true);
    expect(matchesLocation(['Av. Patria 100', 'Guadalajara'], 'jal')).toBe(true);
    expect(matchesLocation(['PASEOS DE ASIENTOS #111, JESUS MARIA AGUSCALIENTES CP:20907'], 'Aguascalientes')).toBe(true);
  });

  it('does not confuse León with Nuevo León', () => {
    expect(matchesLocation(['Av. Leon 12, Monterrey, Nuevo León'], 'guanajuato')).toBe(false);
  });

  it('compound question: efectivo + agosto-like filters + Jalisco + product', () => {
    const orders = [
      { salesOrderNumber: 'A', paymentMethod: 'EFECTIVO', shippingAddressLine1: 'Calle 1', shippingCity: 'Zapopan', items: [{ name: 'PISO PORCELANATO 60X60' }] },
      { salesOrderNumber: 'B', paymentMethod: 'EFECTIVO', shippingAddressLine1: 'Calle 2', shippingCity: 'León', items: [{ name: 'PISO PORCELANATO 60X60' }] },
      { salesOrderNumber: 'C', paymentMethod: 'TRANSFERENCIA', shippingAddressLine1: 'Tonalá, Jalisco', items: [{ name: 'PISO PORCELANATO 60X60' }] },
      { salesOrderNumber: 'D', paymentMethod: 'EFECTIVO', shippingAddressLine1: 'Tlaquepaque', items: [{ name: 'ADHESIVO' }] },
    ];
    const result = applySalesOrderFilters(orders, { paymentMethods: ['EFECTIVO'], shippingLocation: 'Jalisco', product: 'porcelanato' });
    expect(result.map((o) => o.salesOrderNumber)).toEqual(['A']);
  });
});

describe('auditPendingDelivery', () => {
  const ctx = { today, staleDays: 5, highTotalThreshold: null, packages: [] };

  it('OV-23341: scheduled delivery written in the address', () => {
    const { flags, daysOpen } = auditPendingDelivery(
      {
        orderDate: d('2026-09-09'),
        status: 'confirmed',
        paidStatus: 'paid',
        shippedStatus: 'pending',
        deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)',
        shippingAddressLine1: 'CALLE: QUINTA SAN BENITO #7-A FRACC: QUINTA SAN JOSE, SILAO (Entrega programada para el dia 12 de septiembre)',
        total: '7086',
        balance: '0',
      },
      ctx
    );
    expect(daysOpen).toBe(2);
    expect(codes(flags)).toEqual(['entrega_programada']);
    expect(flags[0].reason).toContain('Entrega programada para el dia 12 de septiembre');
  });

  it('OV-23375: balance pending and location must be requested', () => {
    const { flags } = auditPendingDelivery(
      {
        orderDate: d('2026-09-10'),
        status: 'confirmed',
        paidStatus: 'partially_paid',
        shippedStatus: 'pending',
        deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)',
        shippingAddressLine1: 'SAN MATIAS, EN MANUEL DOBLADO..... (FAVOR DE LLAMAR PARA PEDIR UBICACION)',
        total: '18812',
        balance: '2812',
      },
      ctx
    );
    expect(codes(flags)).toEqual(['saldo_pendiente', 'pedir_ubicacion']);
  });

  it('draft with pending payment method', () => {
    const { flags } = auditPendingDelivery(
      { orderDate: d('2026-09-10'), status: 'draft', paymentMethod: 'PENDIENTE DE PAGO', deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', shippingAddressLine1: 'PARQUE INDUSTRIAL', total: '47799', balance: '47799' },
      ctx
    );
    expect(codes(flags)).toEqual(['borrador', 'saldo_pendiente', 'metodo_pago_pendiente']);
  });

  it('old pickup, paid with balance, and package already shipped', () => {
    const { flags, score } = auditPendingDelivery(
      { orderDate: d('2026-08-20'), status: 'confirmed', paidStatus: 'paid', shippedStatus: 'pending', deliveryMethod: 'RECOGE EN BODEGA', total: '500', balance: '100' },
      { ...ctx, packages: [{ packageNumber: 'PKG-1', status: 'shipped' }] }
    );
    expect(codes(flags)).toEqual(['no_ha_recogido', 'pago_incongruente', 'paquete_enviado_orden_pendiente']);
    expect(score).toBe(9);
  });
});

describe('paymentCategory', () => {
  it('groups methods and modes', () => {
    expect(paymentCategory('EFECTIVO EN BODEGA')).toBe('efectivo');
    expect(paymentCategory('Transferencia bancaria')).toBe('transferencia');
    expect(paymentCategory('EFECTIVO Y TARJETA')).toBe('combinado');
    expect(paymentCategory('Tarjeta de crédito')).toBe('tarjeta');
    expect(paymentCategory('CREDITO')).toBe('credito');
    expect(paymentCategory('NOTA DE CREDITO')).toBe('nota de credito');
  });
});

describe('reconcileCashClose', () => {
  const orders = [
    { salesOrderNumber: 'OV-23380', customerName: 'CARMEN HERNANDEZ SANDOVAL', paymentMethod: 'TRANSFERENCIA', status: 'confirmed', paidStatus: 'paid', total: '126730', balance: '0' },
    { salesOrderNumber: 'OV-23378', customerName: 'ALICIA FLORES', paymentMethod: 'EFECTIVO', status: 'confirmed', paidStatus: 'paid', total: '11889', balance: '0' },
    { salesOrderNumber: 'OV-23375', customerName: 'PATRICIA ALFERES', paymentMethod: 'EFECTIVO', status: 'confirmed', paidStatus: 'partially_paid', total: '18812', balance: '2812' },
    { salesOrderNumber: 'OV-23358', customerName: 'MAURICIO SALAZAR VILLALOBOS', paymentMethod: 'TRANSFERENCIA', status: 'confirmed', paidStatus: 'paid', total: '88230', balance: '88230' },
    { salesOrderNumber: 'OV-23311', customerName: 'ABEL TAVAREZ', paymentMethod: 'EFECTIVO Y TARJETA', status: 'closed', paidStatus: 'partially_paid', total: '14658', balance: '10000' },
    { salesOrderNumber: 'OV-23366', customerName: 'RUBEN GONZALEZ', paymentMethod: 'PENDIENTE DE PAGO', status: 'draft', paidStatus: null, total: '47799', balance: '47799' },
    { salesOrderNumber: 'OV-23357', customerName: 'SONIA LOPEZ', paymentMethod: 'EFECTIVO', status: 'confirmed', paidStatus: 'paid', total: '502.56', balance: '0' },
    { salesOrderNumber: 'OV-23339', customerName: 'SONIA LOPEZ', paymentMethod: 'EFECTIVO', status: 'confirmed', paidStatus: 'paid', total: '502.56', balance: '0' },
  ];
  const payments = [
    { paymentNumber: 'P-1', customerName: 'CARMEN HERNANDEZ SANDOVAL', paymentMode: 'Transferencia bancaria', amount: '126730' },
    { paymentNumber: 'P-2', customerName: 'ALICIA FLORES', paymentMode: 'Efectivo', amount: '11889' },
    { paymentNumber: 'P-3', customerName: 'PATRICIA ALFERES', paymentMode: 'Efectivo', amount: '16000' },
    { paymentNumber: 'P-4', customerName: 'PEDRO RAMIREZ', paymentMode: 'Efectivo', amount: '5000' },
  ];
  const result = reconcileCashClose(orders, payments);

  it('excludes drafts and totals the rest', () => {
    expect(result.totals.orders).toBe(7);
    expect(result.totals.excludedOrders).toBe(1);
    expect(result.totals.paymentsReceived).toBe(159619);
  });

  it('compares collected sales vs payments by category', () => {
    const efectivo = result.comparisonByCategory.find((c) => c.category === 'efectivo');
    expect(efectivo).toMatchObject({ collectedPerSales: 28894.12, paymentsReceived: 32889, difference: 3994.88 });
    const transferencia = result.comparisonByCategory.find((c) => c.category === 'transferencia');
    expect(transferencia).toMatchObject({ collectedPerSales: 126730, paymentsReceived: 126730, difference: 0 });
  });

  it('flags every incongruence', () => {
    const found = result.flags.map((f) => `${f.code}:${f.orderNumber ?? f.paymentNumber}`);
    expect(found).toEqual(
      expect.arrayContaining([
        'pagada_con_saldo:OV-23358',
        'efectivo_con_saldo:OV-23375',
        'pago_combinado:OV-23311',
        'posible_duplicado:OV-23357',
        'sin_pago_registrado:OV-23357',
        'sin_pago_registrado:OV-23339',
        'pago_sin_venta_en_periodo:P-4',
      ])
    );
    expect(found).not.toContain('sin_pago_registrado:OV-23380');
    expect(result.flags[0].severity).toBe('alta');
  });
});

describe('summarizeProductRelations', () => {
  it('links products by Zoho item id or by name', () => {
    const result = summarizeProductRelations(
      [
        { name: 'PISO PORCELANATO 60X60', zohoItemId: 'i1', quantity: 20, lineTotal: 8000, party: 'CLIENTE X', document: 'OV-1' },
        { name: 'CEMENTO', zohoItemId: null, quantity: 5, lineTotal: 1000, party: 'CLIENTE X', document: 'OV-1' },
        { name: 'ADHESIVO', zohoItemId: 'i9', quantity: 3, lineTotal: 300, party: 'CLIENTE X', document: 'OV-2' },
      ],
      [
        { name: 'Piso Porcelanato 60x60 (caja)', zohoItemId: 'i1', quantity: 100, lineTotal: 25000, party: 'PROVEEDOR V', document: 'OC-1' },
        { name: 'cemento', zohoItemId: null, quantity: 50, lineTotal: 7000, party: 'PROVEEDOR V', document: 'OC-2' },
      ]
    );
    expect(result.sharedProducts.map((s) => s.product)).toEqual(['PISO PORCELANATO 60X60', 'CEMENTO']);
    expect(result.sharedProducts[0]).toMatchObject({ soldQuantity: 20, purchasedQuantity: 100, vendors: ['PROVEEDOR V'] });
    expect(result.counts).toEqual({ soldProducts: 3, purchasedProducts: 2, sharedProducts: 2 });
  });
});
