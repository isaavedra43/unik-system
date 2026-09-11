import { describe, it, expect } from 'vitest';
import { matchesLocation, matchesStatus, matchesTicketStatus, resolveStatusQuery, statusLabel, textMatches } from './ai-filter-matching';
import { applySalesOrderFilters, perFilterMatchCounts } from './sales-order-ai-filters';
import { getTicketStatus } from '@/modules/sales/sales-orders-helpers';

/** Raw values as stored by the Zoho normalizer, taken from real orders of 2026-09. */
const orders = [
  { salesOrderNumber: 'OV-23381', customerName: 'JUAN CARLOS LOPEZ BARBOSA', salespersonName: 'Axel', status: 'confirmed', invoicedStatus: 'not_invoiced', paidStatus: 'unpaid', shippedStatus: 'shipped', deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', paymentMethod: 'TRANSFERENCIA' },
  { salesOrderNumber: 'OV-23380', customerName: 'CARMEN HERNANDEZ SANDOVAL', salespersonName: 'Axel', status: 'confirmed', invoicedStatus: 'invoiced', paidStatus: 'paid', shippedStatus: 'pending', deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', paymentMethod: 'TRANSFERENCIA' },
  { salesOrderNumber: 'OV-23379', customerName: 'GUILLERMO PEREZ ARAIZA', salespersonName: 'Andrea Gutierrez', status: 'confirmed', invoicedStatus: 'invoiced', paidStatus: 'partially_paid', shippedStatus: 'pending', deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', paymentMethod: 'TRANSFERENCIA' },
  { salesOrderNumber: 'OV-23336', customerName: 'JUAN DIEGO OJEDA SALAZAR', salespersonName: 'Laura Martinez', status: 'confirmed', invoicedStatus: 'not_invoiced', paidStatus: 'unpaid', shippedStatus: 'pending', deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', paymentMethod: 'TRANSFERENCIA' },
  { salesOrderNumber: 'OV-23311', customerName: 'ABEL TAVAREZ', salespersonName: 'Andrea Gutierrez', status: 'closed', invoicedStatus: 'invoiced', paidStatus: 'partially_paid', shippedStatus: 'fulfilled', deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', paymentMethod: 'EFECTIVO Y TARJETA' },
  { salesOrderNumber: 'OV-23366', customerName: 'RUBEN GONZALEZ', salespersonName: 'Laura Martinez', status: 'draft', invoicedStatus: null, paidStatus: null, shippedStatus: null, deliveryMethod: 'A PIE DE OBRA (LIBRE DE MANIOBRAS)', paymentMethod: 'PENDIENTE DE PAGO' },
  { salesOrderNumber: 'OV-23363', customerName: 'JUAN RAMON ROMO', salespersonName: 'Viridiana Fabian', status: 'confirmed', invoicedStatus: 'invoiced', paidStatus: 'unpaid', shippedStatus: 'pending', deliveryMethod: 'INSTALACIÓN A DOMICILIO', paymentMethod: 'EFECTIVO' },
  { salesOrderNumber: 'OV-23364', customerName: 'MARCELA MORALES', salespersonName: 'Axel', status: 'confirmed', invoicedStatus: 'invoiced', paidStatus: 'paid', shippedStatus: 'partially_shipped', deliveryMethod: 'RECOGE EN BODEGA', paymentMethod: 'EFECTIVO' },
];

const numbers = (list: typeof orders) => list.map((o) => o.salesOrderNumber);

describe('matchesStatus — shipped', () => {
  it('"Pendiente" matches raw pending (the bug that returned 0 results)', () => {
    expect(matchesStatus('salesShipped', 'pending', 'Pendiente')).toBe(true);
    expect(matchesStatus('salesShipped', 'shipped', 'Pendiente')).toBe(false);
  });

  it('accepts raw English values and labels', () => {
    expect(matchesStatus('salesShipped', 'pending', 'pending')).toBe(true);
    expect(matchesStatus('salesShipped', 'shipped', 'Enviado')).toBe(true);
    expect(matchesStatus('salesShipped', 'fulfilled', 'Cumplido')).toBe(true);
  });

  it('natural phrases include partial shipments', () => {
    expect(resolveStatusQuery('salesShipped', 'pendientes de entregar')).toEqual(
      expect.arrayContaining(['pending', 'not_shipped', 'partially_shipped'])
    );
    expect(matchesStatus('salesShipped', 'partially_shipped', 'por entregar')).toBe(true);
    expect(matchesStatus('salesShipped', 'shipped', 'sin entregar')).toBe(false);
  });

  it('"entregadas" means shipped, delivered or fulfilled', () => {
    expect(matchesStatus('salesShipped', 'fulfilled', 'entregadas')).toBe(true);
    expect(matchesStatus('salesShipped', 'pending', 'entregadas')).toBe(false);
  });

  it('supports several values in one query', () => {
    expect(matchesStatus('salesShipped', 'partially_shipped', 'Pendiente, Parcial')).toBe(true);
  });
});

describe('matchesStatus — payment and invoicing', () => {
  it('"Pendiente" payment matches unpaid, not partial', () => {
    expect(matchesStatus('salesPaid', 'unpaid', 'Pendiente')).toBe(true);
    expect(matchesStatus('salesPaid', 'partially_paid', 'Pendiente')).toBe(false);
    expect(matchesStatus('salesPaid', 'partially_paid', 'Parcial')).toBe(true);
  });

  it('"con saldo" includes unpaid and partial', () => {
    expect(matchesStatus('salesPaid', 'unpaid', 'con saldo')).toBe(true);
    expect(matchesStatus('salesPaid', 'partially_paid', 'con saldo')).toBe(true);
    expect(matchesStatus('salesPaid', 'paid', 'con saldo')).toBe(false);
  });

  it('"No facturada" does not match "Facturada"', () => {
    expect(matchesStatus('salesInvoiced', 'not_invoiced', 'No facturada')).toBe(true);
    expect(matchesStatus('salesInvoiced', 'invoiced', 'No facturada')).toBe(false);
    expect(matchesStatus('salesInvoiced', 'invoiced', 'Facturada')).toBe(true);
  });

  it('customer invoices "abiertas" include sent and overdue', () => {
    expect(matchesStatus('invoice', 'sent', 'open')).toBe(true);
    expect(matchesStatus('invoice', 'overdue', 'abiertas')).toBe(true);
    expect(matchesStatus('invoice', 'paid', 'abiertas')).toBe(false);
  });

  it('unknown values fall back to substring match', () => {
    expect(matchesStatus('salesOrder', 'some_custom_state', 'custom')).toBe(true);
  });
});

describe('textMatches', () => {
  it('ignores accents, case and extra words', () => {
    expect(textMatches('INSTALACIÓN A DOMICILIO', 'instalacion')).toBe(true);
    expect(textMatches('A PIE DE OBRA (LIBRE DE MANIOBRAS)', 'a pie de obra')).toBe(true);
    expect(textMatches('A PIE DE OBRA (LIBRE DE MANIOBRAS)', 'pie obra')).toBe(true);
    expect(textMatches('RECOGE EN BODEGA', 'a pie de obra')).toBe(false);
  });
});

describe('applySalesOrderFilters — real conversation cases', () => {
  it('"pedidos pendientes de entregar a pie de obra" returns the pending A PIE DE OBRA orders', () => {
    const result = applySalesOrderFilters(orders, { deliveryMethod: 'A PIE DE OBRA', shippedStatus: 'Pendiente' });
    expect(numbers(result)).toEqual(['OV-23380', 'OV-23379', 'OV-23336']);
  });

  it('natural phrase also includes partial shipments', () => {
    const result = applySalesOrderFilters(orders, { shippedStatus: 'pendientes de entrega' });
    expect(numbers(result)).toEqual(['OV-23380', 'OV-23379', 'OV-23336', 'OV-23363', 'OV-23364']);
  });

  it('combines payment status and salesperson', () => {
    const result = applySalesOrderFilters(orders, { paidStatus: 'con saldo', salesperson: 'andrea' });
    expect(numbers(result)).toEqual(['OV-23379', 'OV-23311']);
  });

  it('payment methods are exact (EFECTIVO does not include EFECTIVO Y TARJETA)', () => {
    const result = applySalesOrderFilters(orders, { paymentMethods: ['efectivo'] });
    expect(numbers(result)).toEqual(['OV-23363', 'OV-23364']);
  });

  it('per-filter counts reveal which filter emptied the result', () => {
    const counts = perFilterMatchCounts(orders, { deliveryMethod: 'A PIE DE OBRA', shippedStatus: 'Enviado', customer: 'ruben' });
    expect(counts).toEqual({ deliveryMethod: 6, shippedStatus: 1, customer: 1 });
  });
});

describe('matchesTicketStatus — fixes the "en tránsito" bug (2026-09-11)', () => {
  // A shipped-but-not-closed order (real conversation: "76 A PIE DE OBRA orders in September,
  // the AI only found 8" — because it treated shippedStatus="shipped" as already delivered).
  const ticketOrders = [
    ...orders,
    { salesOrderNumber: 'OV-99001', status: 'confirmed', subStatus: null, invoicedStatus: 'invoiced', paidStatus: 'paid', shippedStatus: 'delivered' },
    { salesOrderNumber: 'OV-99002', status: 'void', subStatus: null, invoicedStatus: null, paidStatus: null, shippedStatus: null },
  ];

  it('OV-23381 (shipped/en tránsito) IS pending delivery, unlike the raw shippedStatus reading', () => {
    const order = orders[0]; // OV-23381: status confirmed, shippedStatus shipped
    expect(getTicketStatus({ status: order.status, subStatus: null, paidStatus: order.paidStatus, invoicedStatus: order.invoicedStatus, shippedStatus: order.shippedStatus }).raw).toBe('in_transit');
    expect(matchesTicketStatus(order, 'pendiente de entrega')).toBe(true);
    // shippedStatus semantics (warehouse dispatch mechanics) are unchanged on purpose.
    expect(matchesStatus('salesShipped', order.shippedStatus, 'por entregar')).toBe(false);
  });

  it('a closed order (OV-23311) is never "pendiente de entrega"', () => {
    expect(matchesTicketStatus(orders[4], 'pendiente de entrega')).toBe(false); // OV-23311, status: closed
  });

  it('a draft order (OV-23366) counts as "no se ha cerrado" but not as "pendiente de entrega" by default', () => {
    expect(matchesTicketStatus(orders[5], 'pendiente de entrega')).toBe(false); // OV-23366, status: draft
    expect(matchesTicketStatus(orders[5], 'no se ha cerrado')).toBe(true);
  });

  it('OV-99001 (delivered, not closed) is "entregado" but not "pendiente de entrega"', () => {
    expect(matchesTicketStatus(ticketOrders[8], 'entregado')).toBe(true);
    expect(matchesTicketStatus(ticketOrders[8], 'pendiente de entrega')).toBe(false);
  });

  it('OV-99002 (void) is neither pending nor delivered', () => {
    expect(matchesTicketStatus(ticketOrders[9], 'pendiente de entrega')).toBe(false);
    expect(matchesTicketStatus(ticketOrders[9], 'entregado')).toBe(false);
  });

  it('matches getTicketStatus\'s own classification for every fixture row (ties the test to the real function)', () => {
    for (const o of ticketOrders) {
      const raw = getTicketStatus({
        status: o.status, subStatus: null, paidStatus: o.paidStatus, invoicedStatus: o.invoicedStatus, shippedStatus: o.shippedStatus,
      }).raw;
      const shouldBePending = !['closed', 'void', 'delivered', 'draft', 'on_hold'].includes(raw);
      expect(matchesTicketStatus(o, 'pendiente de entrega')).toBe(shouldBePending);
    }
  });
});

describe('applySalesOrderFilters — ticketStatus (real bug: querySalesOrders only found 8 of 57 real pending orders)', () => {
  it('"pendiente de entrega" includes the shipped/en-tránsito order that shippedStatus misses', () => {
    const result = applySalesOrderFilters(orders, { ticketStatus: 'pendiente de entrega' });
    expect(numbers(result)).toEqual(['OV-23381', 'OV-23380', 'OV-23379', 'OV-23336', 'OV-23363', 'OV-23364']);
  });

  it('excludes closed and draft orders', () => {
    const result = applySalesOrderFilters(orders, { ticketStatus: 'pendiente de entrega' });
    expect(numbers(result)).not.toContain('OV-23311'); // closed
    expect(numbers(result)).not.toContain('OV-23366'); // draft
  });

  it('combines with deliveryMethod, matching the exact real question that failed', () => {
    const result = applySalesOrderFilters(orders, { deliveryMethod: 'A PIE DE OBRA', ticketStatus: 'pendiente de entrega' });
    expect(numbers(result)).toEqual(['OV-23381', 'OV-23380', 'OV-23379', 'OV-23336']);
  });
});

describe('regression: real "A PIE DE OBRA" September 2026 export (the bug report itself)', () => {
  // 20 real rows from the CSV export the user compared against the assistant on 2026-09-11
  // (out of the full 76-row export: 19 closed/"Entregado", 2 draft, 55 still open — the
  // assistant only found 8 because it counted shippedStatus="shipped"/"Enviado" as delivered).
  // Raw values are back-translated from the export's own Spanish columns
  // (Estado, Facturada, Pago, Envío) using the same maps getTicketStatus reads from.
  const septemberExport = [
    { number: 'OV-23381', status: 'confirmed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'shipped' }, // En tránsito
    { number: 'OV-23380', status: 'confirmed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' }, // Pendiente de envío
    { number: 'OV-23366', status: 'draft', paidStatus: null, invoicedStatus: null, shippedStatus: null }, // Borrador
    { number: 'OV-23368', status: 'confirmed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'shipped' },
    { number: 'OV-23354', status: 'confirmed', paidStatus: 'unpaid', invoicedStatus: 'invoiced', shippedStatus: 'shipped' }, // en tránsito aunque el pago esté pendiente
    { number: 'OV-23375', status: 'confirmed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' },
    { number: 'OV-23378', status: 'confirmed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' },
    { number: 'OV-23379', status: 'confirmed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'shipped' },
    { number: 'OV-23311', status: 'closed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'delivered' }, // Cerrada
    { number: 'OV-23290', status: 'closed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'delivered' },
    { number: 'OV-23336', status: 'confirmed', paidStatus: 'unpaid', invoicedStatus: 'not_invoiced', shippedStatus: 'pending' },
    { number: 'OV-23305', status: 'confirmed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' },
    { number: 'OV-23216', status: 'confirmed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' },
    { number: 'OV-23161', status: 'confirmed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' },
    { number: 'OV-23153', status: 'confirmed', paidStatus: 'partially_paid', invoicedStatus: 'invoiced', shippedStatus: 'pending' },
    { number: 'OV-23149', status: 'draft', paidStatus: null, invoicedStatus: null, shippedStatus: null },
    { number: 'OV-23194', status: 'closed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'delivered' },
    { number: 'OV-23197', status: 'closed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'delivered' },
    { number: 'OV-23238', status: 'closed', paidStatus: 'paid', invoicedStatus: 'invoiced', shippedStatus: 'delivered' },
    { number: 'OV-23308', status: 'confirmed', paidStatus: 'unpaid', invoicedStatus: 'invoiced', shippedStatus: 'shipped' },
  ];
  const expectedPendingNumbers = [
    'OV-23381', 'OV-23380', 'OV-23368', 'OV-23354', 'OV-23375', 'OV-23378', 'OV-23379',
    'OV-23336', 'OV-23305', 'OV-23216', 'OV-23161', 'OV-23153', 'OV-23308',
  ];

  it('every row\'s ticketStatus classification agrees with getTicketStatus directly', () => {
    for (const row of septemberExport) {
      const raw = getTicketStatus({ status: row.status, subStatus: null, paidStatus: row.paidStatus, invoicedStatus: row.invoicedStatus, shippedStatus: row.shippedStatus }).raw;
      const expected = !['closed', 'void', 'delivered', 'draft', 'on_hold'].includes(raw);
      expect(matchesTicketStatus({ status: row.status, paidStatus: row.paidStatus, invoicedStatus: row.invoicedStatus, shippedStatus: row.shippedStatus }, 'pendiente de entrega')).toBe(expected);
    }
  });

  it('returns exactly the 13 non-closed/non-draft rows from this subset of the real export', () => {
    const result = applySalesOrderFilters(
      septemberExport.map((o) => ({ salesOrderNumber: o.number, ...o })),
      { ticketStatus: 'pendiente de entrega' }
    );
    expect(result.map((o) => o.salesOrderNumber).sort()).toEqual([...expectedPendingNumbers].sort());
  });

  it('crucially includes the "shipped/en tránsito" orders the old shippedStatus-only filter missed', () => {
    const inTransit = ['OV-23381', 'OV-23368', 'OV-23354', 'OV-23379', 'OV-23308'];
    for (const number of inTransit) {
      const row = septemberExport.find((o) => o.number === number)!;
      expect(matchesTicketStatus(row, 'pendiente de entrega')).toBe(true);
      // The old, still-valid-for-dispatch-questions filter does NOT count these — that's expected.
      expect(matchesStatus('salesShipped', row.shippedStatus, 'por entregar')).toBe(false);
    }
  });
});

describe('matchesLocation — "en León o en Silao" (reported bug: always 0 results)', () => {
  it('matches a single city named directly, without needing a state', () => {
    expect(matchesLocation(['San Judas león gto, Calle del trabajo #10'], 'Leon')).toBe(true);
    expect(matchesLocation(['Rancho La sarteneja, Cueramaro, Guanajuato'], 'Silao')).toBe(false);
  });

  it('splits "León o Silao" into separate places and matches if either one is found', () => {
    expect(matchesLocation(['San Judas león gto, Calle del trabajo #10'], 'leon o silao')).toBe(true);
    expect(matchesLocation(['Av. Industrias 200, Silao, Guanajuato'], 'leon o silao')).toBe(true);
    expect(matchesLocation(['Rancho La sarteneja, Cueramaro, Guanajuato'], 'leon o silao')).toBe(false);
  });

  it('also splits on comma', () => {
    expect(matchesLocation(['Av. Industrias 200, Silao, Guanajuato'], 'León, Silao')).toBe(true);
  });
});

describe('statusLabel', () => {
  it('translates raw values and humanizes unknown ones', () => {
    expect(statusLabel('salesShipped', 'pending')).toBe('Pendiente');
    expect(statusLabel('salesInvoiced', 'not_invoiced')).toBe('No facturada');
    expect(statusLabel('salesOrder', 'something_new')).toBe('Something New');
    expect(statusLabel('salesShipped', null)).toBeNull();
  });
});
