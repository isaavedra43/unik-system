import { describe, it, expect } from 'vitest';
import { matchesStatus, resolveStatusQuery, statusLabel, textMatches } from './ai-filter-matching';
import { applySalesOrderFilters, perFilterMatchCounts } from './sales-order-ai-filters';

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

describe('statusLabel', () => {
  it('translates raw values and humanizes unknown ones', () => {
    expect(statusLabel('salesShipped', 'pending')).toBe('Pendiente');
    expect(statusLabel('salesInvoiced', 'not_invoiced')).toBe('No facturada');
    expect(statusLabel('salesOrder', 'something_new')).toBe('Something New');
    expect(statusLabel('salesShipped', null)).toBeNull();
  });
});
