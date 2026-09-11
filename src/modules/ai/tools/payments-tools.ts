import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { documentNumberOrConditions, matchesStatus, textMatches } from './ai-filter-matching';
import {
  dateRangeSchema,
  formatDate,
  buildDateWhereFlexible,
} from './date-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return Number(String(value));
  }
  return Number(value);
}

/* ------------------------------------------------------------------ */
/* 1. queryPayments — Universal customer payments query tool          */
/* ------------------------------------------------------------------ */

const PAYMENT_GROUP_BY = ['none', 'customer', 'paymentMode', 'status', 'date'] as const;

registerTool({
  name: 'queryPayments',
  description:
    'TOOL UNIVERSAL de pagos recibidos de clientes. Úsalo para CUALQUIER consulta de pagos. ' +
    'Soporta filtrar por fecha, cliente (customer), método de pago (paymentMode), estado (status) y moneda (currency). ' +
    'Puede agrupar por cliente, método de pago, estado o fecha. ' +
    'EJEMPLOS: ' +
    '"pagos de esta semana" → queryPayments(dateRange="this_week"). ' +
    '"pagos en efectivo de hoy" → queryPayments(dateRange="today", paymentMode="EFECTIVO"). ' +
    '"pagos del cliente X" → queryPayments(customer="X"). ' +
    '"pagos por método de pago de este mes" → queryPayments(dateRange="this_month", groupBy="paymentMode"). ' +
    '"pagos por cliente de esta semana" → queryPayments(dateRange="this_week", groupBy="customer"). ' +
    'PATRONES: "me pagaron esta semana" = dateRange="this_week" • "pagos por cliente" = groupBy="customer" • "pagos en transferencia hoy" = dateRange="today", paymentMode="TRANSFERENCIA".',
  category: 'payments',
  requiredPermission: 'payments.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    customer: z.string().optional().describe('Filtrar por nombre del cliente (búsqueda parcial).'),
    paymentMode: z.string().optional().describe(
      'Filtrar por método de pago (búsqueda parcial). Ej: "EFECTIVO", "TRANSFERENCIA", "TARJETA", "DEPOSITO".'
    ),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "success", "refunded", "void".'
    ),
    currency: z.string().optional().describe('Filtrar por moneda (ej: "MXN", "USD").'),
    search: z.string().optional().describe('Búsqueda libre en número de pago, cliente, referencia.'),
    groupBy: z.enum(PAYMENT_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "customer" = por cliente. "paymentMode" = por método de pago. "status" = por estado. "date" = por fecha.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string; dateFrom?: string; dateTo?: string;
      customer?: string; paymentMode?: string; status?: string; currency?: string; search?: string;
      groupBy: (typeof PAYMENT_GROUP_BY)[number]; page: number; pageSize: number;
    };

    const dateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');
    const where: Record<string, unknown> = { ...dateWhere };

    const payments = await prisma.customerPayment.findMany({
      where: where as never,
      select: {
        id: true,
        paymentNumber: true,
        customerName: true,
        paymentMode: true,
        status: true,
        date: true,
        amount: true,
        balance: true,
        currencyCode: true,
        referenceNumber: true,
        description: true,
        bankCharges: true,
      },
      orderBy: { date: 'desc' },
      take: 20000,
    });

    // Apply filters in JavaScript for reliability
    let filtered = payments;

    if (args.customer) {
      const c = args.customer;
      filtered = filtered.filter((o) => textMatches(o.customerName, c));
    }
    if (args.paymentMode) {
      const pm = args.paymentMode;
      filtered = filtered.filter((o) => textMatches(o.paymentMode, pm));
    }
    if (args.status) {
      const s = args.status;
      filtered = filtered.filter((o) => matchesStatus('customerPayment', o.status, s));
    }
    if (args.currency) {
      const c = args.currency.toUpperCase();
      filtered = filtered.filter((o) => (o.currencyCode?.toUpperCase() ?? '') === c);
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.paymentNumber?.toLowerCase() ?? '').includes(s) ||
        (o.customerName?.toLowerCase() ?? '').includes(s) ||
        (o.referenceNumber?.toLowerCase() ?? '').includes(s)
      );
    }

    // Auto-diagnóstico
    const usedFilter = !!(args.status || args.paymentMode);
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedFilter) {
      const uniqueStatuses = new Map<string, number>();
      const uniqueModes = new Map<string, number>();
      for (const o of payments) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
        if (o.paymentMode) uniqueModes.set(o.paymentMode, (uniqueModes.get(o.paymentMode) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores disponibles:',
        totalPaymentsInDateRange: payments.length,
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availablePaymentModes: [...uniqueModes.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista.',
      };
    }

    if (args.groupBy === 'none') {
      const total = filtered.length;
      const totalPages = Math.ceil(total / args.pageSize);
      const paginated = filtered.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);
      const amountSum = filtered.reduce((s, o) => s + toNumber(o.amount), 0);
      const balanceSum = filtered.reduce((s, o) => s + toNumber(o.balance), 0);

      return {
        mode: 'list',
        total, page: args.page, pageSize: args.pageSize, totalPages,
        amountSum: amountSum.toFixed(2), balanceSum: balanceSum.toFixed(2),
        dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
        filters: {
          customer: args.customer ?? null, paymentMode: args.paymentMode ?? null,
          status: args.status ?? null, currency: args.currency ?? null, search: args.search ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        payments: paginated.map((o) => ({
          number: o.paymentNumber, customer: o.customerName, paymentMode: o.paymentMode,
          status: o.status, date: formatDate(o.date),
          amount: decimalToString(o.amount), balance: decimalToString(o.balance),
          currency: o.currencyCode, referenceNumber: o.referenceNumber,
          description: o.description, bankCharges: decimalToString(o.bankCharges),
        })),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; amount: number; balance: number; payments: typeof filtered }>();
    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'customer') key = o.customerName ?? 'SIN CLIENTE';
      else if (args.groupBy === 'paymentMode') key = o.paymentMode ?? 'SIN MÉTODO';
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'date') key = formatDate(o.date) ?? 'SIN FECHA';
      const g = groups.get(key) ?? { count: 0, amount: 0, balance: 0, payments: [] as typeof filtered };
      g.count++; g.amount += toNumber(o.amount); g.balance += toNumber(o.balance); g.payments.push(o);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count, amount: g.amount.toFixed(2), balance: g.balance.toFixed(2),
        payments: g.payments.slice(0, 50).map((o) => ({
          number: o.paymentNumber, customer: o.customerName, paymentMode: o.paymentMode,
          status: o.status, date: formatDate(o.date),
          amount: decimalToString(o.amount), balance: decimalToString(o.balance),
        })),
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount));

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalPayments: filtered.length,
      totalAmount: filtered.reduce((s, o) => s + toNumber(o.amount), 0).toFixed(2),
      totalBalance: filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: {
        customer: args.customer ?? null, paymentMode: args.paymentMode ?? null,
        status: args.status ?? null, currency: args.currency ?? null, search: args.search ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 2. getPaymentDetail — Detail by number/ID                           */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getPaymentDetail',
  description: 'Detalle completo de un pago recibido por su número o ID interno.',
  category: 'payments',
  requiredPermission: 'payments.view',
  enabledByDefault: true,
  parameters: z.object({
    paymentNumber: z.string().min(1).describe('Número del pago o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { paymentNumber: string };
    const payment = await prisma.customerPayment.findFirst({
      where: {
        OR: [
          ...documentNumberOrConditions('paymentNumber', args.paymentNumber),
          { id: args.paymentNumber },
        ],
      },
    });
    if (!payment) return { found: false, searchedNumber: args.paymentNumber };
    return {
      found: true,
      payment: {
        id: payment.id,
        number: payment.paymentNumber,
        customer: payment.customerName,
        paymentMode: payment.paymentMode,
        status: payment.status,
        date: formatDate(payment.date),
        amount: decimalToString(payment.amount),
        balance: decimalToString(payment.balance),
        currency: payment.currencyCode,
        referenceNumber: payment.referenceNumber,
        description: payment.description,
        bankCharges: decimalToString(payment.bankCharges),
        exchangeRate: decimalToString(payment.exchangeRate),
      },
    };
  },
});
