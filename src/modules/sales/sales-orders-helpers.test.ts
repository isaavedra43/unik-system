import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatDateOnly,
  formatQuantity,
  getSalesOrderStatusConfig,
} from './sales-orders-helpers';

/**
 * OV-23162 fixture based on the real PDF acceptance criteria.
 * Values are the canonical UI display expectations, not the raw Zoho strings.
 */
const ov23162 = {
  salesOrderNumber: 'OV-23162',
  orderDate: '2026-09-01',
  customerName: 'GABRIEL FLORES ESTRADA',
  salespersonName: 'Andrea Gutierrez',
  paymentMethod: 'EFECTIVO',
  deliveryMethod: 'RECOGE EN BODEGA',
  locationName: 'Patio Unik',
  status: 'confirmed',
  paidStatus: 'paid',
  invoicedStatus: 'invoiced',
  shippedStatus: 'pending',
  currencyCode: 'MXN',
  subtotal: '2396.00',
  total: '2396.00',
};

describe('Sales Orders helpers', () => {
  describe('formatDateOnly', () => {
    it('renders 2026-09-01 as 1 sep 2026 in es-MX without timezone shift', () => {
      expect(formatDateOnly('2026-09-01')).toBe('1 sep 2026');
    });

    it('renders the same calendar day from a UTC Date object', () => {
      const d = new Date(Date.UTC(2026, 8, 1, 0, 0, 0));
      expect(formatDateOnly(d)).toBe('1 sep 2026');
    });

    it('returns em-dash for null/undefined', () => {
      expect(formatDateOnly(null)).toBe('—');
      expect(formatDateOnly(undefined)).toBe('—');
    });
  });

  describe('formatCurrency', () => {
    it('renders OV-23162 total as $2,396.00 MXN', () => {
      expect(formatCurrency(ov23162.total, ov23162.currencyCode)).toBe('$2,396.00 MXN');
    });

    it('renders amount without currency when no currency is supplied', () => {
      expect(formatCurrency('9488.16')).toBe('$9,488.16');
    });

    it('returns em-dash for null', () => {
      expect(formatCurrency(null)).toBe('—');
    });
  });

  describe('formatQuantity', () => {
    it('renders quantity with unit', () => {
      expect(formatQuantity('4', 'm2')).toBe('4 m2');
    });

    it('handles decimal quantities', () => {
      expect(formatQuantity(2.5, 'kg')).toBe('2.5 kg');
    });
  });

  describe('getSalesOrderStatusConfig', () => {
    it('maps confirmed → Confirmada', () => {
      const config = getSalesOrderStatusConfig(ov23162.status, 'order');
      expect(config.label).toBe('Confirmada');
      expect(config.tone).toBe('info');
    });

    it('maps paid → Pagada', () => {
      expect(getSalesOrderStatusConfig(ov23162.paidStatus, 'payment').label).toBe('Pagada');
    });

    it('maps invoiced → Facturada', () => {
      expect(getSalesOrderStatusConfig(ov23162.invoicedStatus, 'invoice').label).toBe('Facturada');
    });

    it('maps pending → Pendiente for shipping', () => {
      expect(getSalesOrderStatusConfig(ov23162.shippedStatus, 'shipping').label).toBe('Pendiente');
    });

    it('humanizes unknown raw values and defaults to muted tone', () => {
      const config = getSalesOrderStatusConfig('custom_status_value', 'order');
      expect(config.label).toBe('Custom Status Value');
      expect(config.tone).toBe('muted');
    });

    it('returns em-dash for null/undefined', () => {
      const config = getSalesOrderStatusConfig(null, 'order');
      expect(config.label).toBe('—');
    });
  });
});
