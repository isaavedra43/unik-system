import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { auditPendingDelivery } from './audit-logic';
import { getTicketStatus } from '@/modules/sales/sales-orders-helpers';
import { resolveContact } from '@/modules/comms/contact-resolver';
import { normalizePhone } from '@/modules/comms/normalize';

/**
 * Insight & proactive-work tools: the assistant does the analysis and prepares
 * the messages; the user only approves. All read-only except createChatEvent
 * (internal_task). Money is returned as numbers (MXN) ready for reports.
 */

const SALES_PERMISSION = 'sales_orders.view';

function num(v: Prisma.Decimal | number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : 0;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function ticketOf(o: { status: string | null; subStatus: string | null; paidStatus: string | null; invoicedStatus: string | null; shippedStatus: string | null }): string {
  return getTicketStatus({ status: o.status, subStatus: o.subStatus, paidStatus: o.paidStatus, invoicedStatus: o.invoicedStatus, shippedStatus: o.shippedStatus }).label;
}

async function resolveCustomer(ref: string): Promise<{ zohoCustomerId: string | null; name: string; phone: string | null }> {
  const byZoho = await prisma.contact.findFirst({ where: { OR: [{ zohoContactId: ref }, { contactName: { equals: ref, mode: 'insensitive' } }, { companyName: { equals: ref, mode: 'insensitive' } }] } });
  if (byZoho) return { zohoCustomerId: byZoho.zohoContactId, name: byZoho.contactName ?? byZoho.companyName ?? ref, phone: normalizePhone(byZoho.primaryPhone ?? byZoho.mobile ?? null) };
  const like = await prisma.contact.findMany({ where: { OR: [{ contactName: { contains: ref, mode: 'insensitive' } }, { companyName: { contains: ref, mode: 'insensitive' } }] }, take: 3 });
  if (like.length === 1) return { zohoCustomerId: like[0].zohoContactId, name: like[0].contactName ?? like[0].companyName ?? ref, phone: normalizePhone(like[0].primaryPhone ?? like[0].mobile ?? null) };
  const so = await prisma.salesOrder.findFirst({ where: { customerName: { contains: ref, mode: 'insensitive' } }, orderBy: { orderDate: 'desc' }, select: { zohoCustomerId: true, customerName: true, customerPhone: true } });
  if (so) return { zohoCustomerId: so.zohoCustomerId, name: so.customerName ?? ref, phone: normalizePhone(so.customerPhone) };
  return { zohoCustomerId: null, name: ref, phone: null };
}

// ---------------------------------------------------------------------------
// 1. Customer health
// ---------------------------------------------------------------------------
registerTool({
  name: 'getCustomerHealth',
  description:
    'Salud comercial de un cliente en una sola llamada: compras 90/365 días, última compra, frecuencia, saldo pendiente, facturas vencidas, cotizaciones abiertas, tono de sus últimos mensajes y un score 0-100 con recomendaciones.',
  category: 'contacts',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ customer: z.string().min(1).describe('Nombre o zohoContactId del cliente') }),
  execute: async (_actor, rawArgs) => {
    const { customer } = rawArgs as { customer: string };
    const c = await resolveCustomer(customer);
    const where: Prisma.SalesOrderWhereInput = c.zohoCustomerId ? { zohoCustomerId: c.zohoCustomerId } : { customerName: { contains: c.name, mode: 'insensitive' } };
    const [orders, invoices, quotes, inboxContact] = await Promise.all([
      prisma.salesOrder.findMany({ where, orderBy: { orderDate: 'desc' }, take: 200, select: { orderDate: true, total: true, balance: true, status: true, subStatus: true, paidStatus: true, invoicedStatus: true, shippedStatus: true } }),
      prisma.invoice.findMany({ where: c.zohoCustomerId ? { zohoCustomerId: c.zohoCustomerId } : { customerName: { contains: c.name, mode: 'insensitive' } }, select: { balance: true, dueDate: true, status: true } }),
      prisma.quote.findMany({ where: c.zohoCustomerId ? { zohoCustomerId: c.zohoCustomerId } : { customerName: { contains: c.name, mode: 'insensitive' } }, select: { status: true, total: true, estimateNumber: true } }),
      c.zohoCustomerId ? prisma.commContact.findFirst({ where: { zohoContactId: c.zohoCustomerId } }) : c.phone ? prisma.commContact.findFirst({ where: { phone: c.phone } }) : Promise.resolve(null),
    ]);
    const now = Date.now();
    const in90 = orders.filter((o) => o.orderDate && now - o.orderDate.getTime() < 90 * 86_400_000);
    const in365 = orders.filter((o) => o.orderDate && now - o.orderDate.getTime() < 365 * 86_400_000);
    const total365 = in365.reduce((s, o) => s + num(o.total), 0);
    const total90 = in90.reduce((s, o) => s + num(o.total), 0);
    const openBalance = orders.reduce((s, o) => s + num(o.balance), 0);
    const overdue = invoices.filter((i) => num(i.balance) > 0 && i.dueDate && i.dueDate.getTime() < now);
    const overdueAmount = overdue.reduce((s, i) => s + num(i.balance), 0);
    const lastOrder = orders[0]?.orderDate ?? null;
    const daysSinceLast = lastOrder ? Math.round((now - lastOrder.getTime()) / 86_400_000) : null;
    const dates = orders.map((o) => o.orderDate?.getTime() ?? 0).filter(Boolean).sort((a, b) => b - a);
    const gaps = dates.slice(0, 10).map((d, i, arr) => (i < arr.length - 1 ? (d - arr[i + 1]) / 86_400_000 : null)).filter((g): g is number => g !== null);
    const avgGapDays = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
    const openQuotes = quotes.filter((q) => ['draft', 'sent', 'expired'].includes(q.status ?? ''));

    let recentTone: string | null = null;
    let lastMessages: string[] = [];
    if (inboxContact) {
      const msgs = await prisma.commMessage.findMany({ where: { conversation: { contactId: inboxContact.id }, direction: 'inbound', body: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5, select: { body: true, createdAt: true } });
      lastMessages = msgs.map((m) => `[${m.createdAt.toISOString().slice(0, 10)}] ${(m.body ?? '').slice(0, 160)}`);
      const joined = msgs.map((m) => (m.body ?? '').toLowerCase()).join(' ');
      recentTone = /molest|queja|mal|tarde|urgente|no llega|reclam|cancel/.test(joined) ? 'negativo/urgente' : /gracias|excelente|perfecto|bien/.test(joined) ? 'positivo' : msgs.length ? 'neutral' : null;
    }

    let score = 50;
    if (in90.length > 0) score += 15;
    if (in365.length >= 4) score += 10;
    if (daysSinceLast !== null && avgGapDays !== null && daysSinceLast > avgGapDays * 2) score -= 15;
    if (overdueAmount > 0) score -= Math.min(25, 5 + Math.round(overdueAmount / 10_000));
    if (recentTone === 'negativo/urgente') score -= 10;
    if (recentTone === 'positivo') score += 5;
    score = Math.max(0, Math.min(100, score));

    const recommendations: string[] = [];
    if (overdue.length) recommendations.push(`Cobrar ${overdue.length} factura(s) vencida(s) por $${overdueAmount.toLocaleString('es-MX', { minimumFractionDigits: 2 })} (draftCollectionReminders).`);
    if (daysSinceLast !== null && avgGapDays !== null && daysSinceLast > avgGapDays * 1.5) recommendations.push(`Lleva ${daysSinceLast} días sin comprar (su ritmo era cada ~${avgGapDays} días): proponer reactivación.`);
    if (openQuotes.length) recommendations.push(`Dar seguimiento a ${openQuotes.length} cotización(es) abierta(s): ${openQuotes.map((q) => q.estimateNumber).filter(Boolean).join(', ')}.`);
    if (recentTone === 'negativo/urgente') recommendations.push('Sus últimos mensajes suenan molestos/urgentes: atender primero.');

    return {
      customer: c.name,
      zohoCustomerId: c.zohoCustomerId,
      score,
      orders: { last90d: in90.length, last365d: in365.length, total90d: Math.round(total90 * 100) / 100, total365d: Math.round(total365 * 100) / 100, lastOrderDate: lastOrder?.toISOString().slice(0, 10) ?? null, daysSinceLast, avgGapDays },
      openBalance: Math.round(openBalance * 100) / 100,
      overdueInvoices: { count: overdue.length, amount: Math.round(overdueAmount * 100) / 100 },
      openQuotes: openQuotes.length,
      openOrdersByTicket: Object.entries(orders.slice(0, 50).reduce<Record<string, number>>((acc, o) => { const t = ticketOf(o); acc[t] = (acc[t] ?? 0) + 1; return acc; }, {})),
      recentTone,
      lastMessages,
      recommendations,
    };
  },
});

// ---------------------------------------------------------------------------
// 2. Collection reminders
// ---------------------------------------------------------------------------
registerTool({
  name: 'draftCollectionReminders',
  description:
    'Prepara recordatorios de cobranza: facturas con saldo vencido agrupadas por cliente, con teléfono y un mensaje cordial listo por cliente. Devuelve "recipients" que puedes pasar directamente a sendBulkMessages (con aprobación).',
  category: 'finance',
  requiredPermission: 'invoices.view',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({
    minDaysOverdue: z.number().int().min(0).max(365).default(1),
    limit: z.number().int().min(1).max(50).default(20),
    tone: z.enum(['cordial', 'firme']).default('cordial'),
  }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { minDaysOverdue: number; limit: number; tone: 'cordial' | 'firme' };
    const cutoff = daysAgo(a.minDaysOverdue);
    const invoices = await prisma.invoice.findMany({
      where: { balance: { gt: 0 }, dueDate: { lt: cutoff }, status: { notIn: ['void', 'draft', 'paid'] } },
      orderBy: { dueDate: 'asc' },
      take: 500,
      select: { invoiceNumber: true, dueDate: true, balance: true, customerName: true, zohoCustomerId: true, currencyCode: true },
    });
    const byCustomer = new Map<string, { name: string; zohoCustomerId: string | null; invoices: typeof invoices; total: number }>();
    for (const inv of invoices) {
      const key = inv.zohoCustomerId ?? inv.customerName ?? '—';
      const group = byCustomer.get(key) ?? { name: inv.customerName ?? key, zohoCustomerId: inv.zohoCustomerId, invoices: [], total: 0 };
      group.invoices.push(inv);
      group.total += num(inv.balance);
      byCustomer.set(key, group);
    }
    const groups = [...byCustomer.values()].sort((x, y) => y.total - x.total).slice(0, a.limit);
    const recipients = [];
    for (const g of groups) {
      const contact = g.zohoCustomerId ? await prisma.contact.findUnique({ where: { zohoContactId: g.zohoCustomerId }, select: { primaryPhone: true, mobile: true } }) : null;
      const phone = normalizePhone(contact?.primaryPhone ?? contact?.mobile ?? null);
      const list = g.invoices.slice(0, 5).map((i) => `• ${i.invoiceNumber} (venció ${i.dueDate?.toISOString().slice(0, 10)}): $${num(i.balance).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`).join('\n');
      const body = a.tone === 'firme'
        ? `Hola ${g.name}, le recordamos que tiene ${g.invoices.length} factura(s) vencida(s) por un total de $${g.total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}:\n${list}\nLe pedimos regularizar el pago a la brevedad. Si ya lo realizó, compártanos el comprobante. Gracias.`
        : `Hola ${g.name}, ¿cómo está? Le escribimos de UNIK para recordarle amablemente que tiene ${g.invoices.length} factura(s) pendiente(s) por $${g.total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}:\n${list}\n¿Nos ayuda con el pago o nos indica una fecha? Si ya pagó, ignore este mensaje y compártanos el comprobante. ¡Gracias!`;
      recipients.push({ contact: phone ?? g.name, customer: g.name, phone, invoices: g.invoices.length, amount: Math.round(g.total * 100) / 100, body });
    }
    return { customers: recipients.length, totalOverdue: Math.round(groups.reduce((s, g) => s + g.total, 0) * 100) / 100, recipients, note: 'Muestra el resumen al usuario y, si lo aprueba, envía con sendBulkMessages (recipients tal cual). Los clientes sin teléfono necesitan que el usuario indique el número.' };
  },
});

// ---------------------------------------------------------------------------
// 3. Delayed deliveries → customer notices
// ---------------------------------------------------------------------------
registerTool({
  name: 'notifyDelayedDeliveries',
  description:
    'Detecta pedidos pendientes de entrega con retraso y prepara un aviso para cada cliente (con teléfono). Devuelve "recipients" listos para sendBulkMessages y el detalle de por qué cada pedido está detenido.',
  category: 'sales',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({ daysLate: z.number().int().min(1).max(90).default(3), limit: z.number().int().min(1).max(50).default(20) }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { daysLate: number; limit: number };
    const orders = await prisma.salesOrder.findMany({
      where: { orderDate: { lt: daysAgo(a.daysLate) }, status: { notIn: ['void', 'closed', 'cancelled'] }, shippedStatus: { not: 'shipped' } },
      orderBy: { orderDate: 'asc' },
      take: 300,
    });
    const today = new Date();
    const flagged = orders
      .map((o) => ({ order: o, ticket: ticketOf(o), audit: auditPendingDelivery({ salesOrderNumber: o.salesOrderNumber, orderDate: o.orderDate, status: o.status, paidStatus: o.paidStatus, shippedStatus: o.shippedStatus, paymentMethod: o.paymentMethod, deliveryMethod: o.deliveryMethod, shippingAddressLine1: o.shippingAttention, shippingCity: o.shippingCity, shippingState: o.shippingState, notes: o.notes, total: o.total, balance: o.balance }, { today, staleDays: a.daysLate, highTotalThreshold: null, packages: [] }) }))
      .filter((x) => !['Cerrado', 'Anulado', 'Entregado'].includes(x.ticket))
      .sort((x, y) => y.audit.score - x.audit.score)
      .slice(0, a.limit);
    const recipients = flagged.map((x) => {
      const phone = normalizePhone(x.order.customerPhone);
      const body = `Hola ${x.order.customerName ?? ''}, le escribimos de UNIK sobre su pedido ${x.order.salesOrderNumber}. Estamos dando seguimiento a la entrega${x.audit.daysOpen ? ` (lleva ${x.audit.daysOpen} días)` : ''}. ${num(x.order.balance) > 0 ? 'Para liberarlo necesitamos completar el pago pendiente; ' : ''}¿Nos confirma que la dirección y el horario de recepción siguen siendo los mismos? Gracias.`;
      return { contact: phone ?? x.order.customerName ?? '', order: x.order.salesOrderNumber, customer: x.order.customerName, phone, daysOpen: x.audit.daysOpen, ticket: x.ticket, reasons: x.audit.flags.map((f) => f.reason), body };
    });
    return { count: recipients.length, recipients, note: 'Revisa las razones antes de enviar: no avises al cliente de un retraso que sea por falta de pago sin decírselo con tacto.' };
  },
});

// ---------------------------------------------------------------------------
// 4. Suggest assignee (load balance)
// ---------------------------------------------------------------------------
registerTool({
  name: 'suggestAssignee',
  description: 'Sugiere a quién asignar una conversación de la bandeja según la carga actual (conversaciones abiertas por persona) y quién atendió antes a ese contacto.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ inboxConversationId: z.string().min(1) }),
  execute: async (actor, rawArgs) => {
    const { inboxConversationId } = rawArgs as { inboxConversationId: string };
    const { listInboxUsers } = await import('@/modules/comms/comms-service');
    const users = await listInboxUsers(actor);
    const conv = await prisma.commConversation.findUnique({ where: { id: inboxConversationId }, select: { contactId: true, assignedToUserId: true } });
    if (!conv) return { error: 'Conversación no encontrada' };
    const loads = await prisma.commConversation.groupBy({ by: ['assignedToUserId'], where: { status: { in: ['open', 'pending'] }, assignedToUserId: { not: null } }, _count: { _all: true } });
    const loadByUser = new Map(loads.map((l) => [l.assignedToUserId as string, l._count._all]));
    const previous = await prisma.commConversation.findFirst({ where: { contactId: conv.contactId, assignedToUserId: { not: null }, id: { not: inboxConversationId } }, orderBy: { lastMessageAt: 'desc' }, select: { assignedToUserId: true } });
    const ranked = users.map((u) => ({ userId: u.id, name: u.name, openConversations: loadByUser.get(u.id) ?? 0, attendedBefore: previous?.assignedToUserId === u.id })).sort((x, y) => Number(y.attendedBefore) - Number(x.attendedBefore) || x.openConversations - y.openConversations);
    return { current: conv.assignedToUserId, suggestion: ranked[0] ?? null, candidates: ranked, note: 'Para asignar usa updateInboxConversation con assignedToUserId.' };
  },
});

// ---------------------------------------------------------------------------
// 5. Recent activity ("qué pasó desde…")
// ---------------------------------------------------------------------------
registerTool({
  name: 'getRecentActivity',
  description: 'Qué ha pasado en UNIK en las últimas N horas: ventas nuevas, facturas, pagos, cotizaciones, mensajes de clientes sin responder, menciones en chat y compromisos vencidos. Ideal para "ponme al día".',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ hours: z.number().int().min(1).max(24 * 14).default(24) }),
  execute: async (actor, rawArgs) => {
    const { hours } = rawArgs as { hours: number };
    const since = new Date(Date.now() - hours * 3_600_000);
    const has = (p: string) => actor.isSuperAdmin || (actor.permissionKeys as string[]).includes(p);
    const [orders, invoices, payments, quotes, unanswered, mentions, overdue] = await Promise.all([
      has(SALES_PERMISSION) ? prisma.salesOrder.findMany({ where: { createdTime: { gte: since } }, select: { salesOrderNumber: true, customerName: true, total: true, salespersonName: true }, orderBy: { createdTime: 'desc' }, take: 30 }) : [],
      has('invoices.view') ? prisma.invoice.count({ where: { createdAt: { gte: since } } }) : 0,
      has('payments.view') ? prisma.customerPayment.aggregate({ where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { amount: true } }) : null,
      has('quotes.view') ? prisma.quote.findMany({ where: { createdAt: { gte: since } }, select: { estimateNumber: true, customerName: true, total: true, status: true }, take: 20 }) : [],
      has('inbox.use') ? prisma.commConversation.findMany({ where: { status: 'open', lastInboundAt: { gte: since }, unreadCount: { gt: 0 } }, select: { id: true, contact: { select: { displayName: true } }, lastInboundAt: true, unreadCount: true }, orderBy: { lastInboundAt: 'desc' }, take: 20 }) : [],
      has('chat.use') ? prisma.internalChatMention.count({ where: { userId: actor.id, message: { createdAt: { gte: since } } } }) : 0,
      has('inbox.use') ? prisma.commitment.findMany({ where: { ownerUserId: actor.id, status: 'pending', dueAt: { lt: new Date() } }, select: { description: true, dueAt: true }, take: 10 }) : [],
    ]);
    return {
      sinceHours: hours,
      newSalesOrders: { count: orders.length, total: Math.round(orders.reduce((s, o) => s + num(o.total), 0) * 100) / 100, items: orders.slice(0, 10).map((o) => ({ folio: o.salesOrderNumber, customer: o.customerName, total: num(o.total), salesperson: o.salespersonName })) },
      newInvoices: invoices,
      paymentsReceived: payments ? { count: payments._count._all, total: num(payments._sum.amount) } : null,
      newQuotes: quotes.map((q) => ({ folio: q.estimateNumber, customer: q.customerName, total: num(q.total), status: q.status })),
      customersWaitingReply: unanswered.map((c) => ({ conversationId: c.id, contact: c.contact.displayName, unread: c.unreadCount, since: c.lastInboundAt })),
      chatMentions: mentions,
      overdueCommitments: overdue.map((c) => ({ description: c.description, dueAt: c.dueAt })),
    };
  },
});

// ---------------------------------------------------------------------------
// 6. Salesperson scorecard
// ---------------------------------------------------------------------------
registerTool({
  name: 'getSalespersonScorecard',
  description: 'Tarjeta de desempeño por vendedor en un periodo: órdenes, venta total, ticket promedio, saldo pendiente, % entregado, clientes distintos y top clientes. Devuelve filas listas para PDF/Excel.',
  category: 'sales',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    salesperson: z.string().optional().describe('Nombre del vendedor; vacío = todos'),
    dateFrom: z.string().describe('yyyy-mm-dd'),
    dateTo: z.string().describe('yyyy-mm-dd'),
  }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { salesperson?: string; dateFrom: string; dateTo: string };
    const from = new Date(a.dateFrom);
    const to = new Date(a.dateTo);
    to.setUTCHours(23, 59, 59, 999);
    const orders = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to }, ...(a.salesperson ? { salespersonName: { contains: a.salesperson, mode: 'insensitive' } } : {}), status: { notIn: ['void'] } },
      select: { salespersonName: true, customerName: true, total: true, balance: true, status: true, subStatus: true, paidStatus: true, invoicedStatus: true, shippedStatus: true },
    });
    const groups = new Map<string, { orders: number; total: number; balance: number; delivered: number; customers: Map<string, number> }>();
    for (const o of orders) {
      const key = o.salespersonName ?? 'Sin vendedor';
      const g = groups.get(key) ?? { orders: 0, total: 0, balance: 0, delivered: 0, customers: new Map() };
      g.orders += 1;
      g.total += num(o.total);
      g.balance += num(o.balance);
      const t = ticketOf(o);
      if (t === 'Cerrado' || t === 'Entregado') g.delivered += 1;
      if (o.customerName) g.customers.set(o.customerName, (g.customers.get(o.customerName) ?? 0) + num(o.total));
      groups.set(key, g);
    }
    const rows = [...groups.entries()].map(([salesperson, g]) => ({
      vendedor: salesperson,
      ordenes: g.orders,
      ventaTotal: Math.round(g.total * 100) / 100,
      ticketPromedio: g.orders ? Math.round((g.total / g.orders) * 100) / 100 : 0,
      saldoPendiente: Math.round(g.balance * 100) / 100,
      porcentajeEntregado: g.orders ? Math.round((g.delivered / g.orders) * 100) : 0,
      clientes: g.customers.size,
      topClientes: [...g.customers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, v]) => `${n} ($${Math.round(v).toLocaleString('es-MX')})`).join(', '),
    })).sort((x, y) => y.ventaTotal - x.ventaTotal);
    return { period: { from: a.dateFrom, to: a.dateTo }, count: rows.length, rows, totals: { ordenes: orders.length, ventaTotal: Math.round(rows.reduce((s, r) => s + r.ventaTotal, 0) * 100) / 100 } };
  },
});

// ---------------------------------------------------------------------------
// 7. Reactivation opportunities
// ---------------------------------------------------------------------------
registerTool({
  name: 'findReactivationOpportunities',
  description: 'Clientes que compraban con regularidad y llevan N días sin comprar (oportunidad de reactivación), con lo que solían pedir y su teléfono para contactarlos.',
  category: 'sales',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ inactiveDays: z.number().int().min(15).max(730).default(60), minOrders: z.number().int().min(1).max(50).default(2), limit: z.number().int().min(1).max(50).default(20) }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { inactiveDays: number; minOrders: number; limit: number };
    const grouped = await prisma.salesOrder.groupBy({ by: ['zohoCustomerId', 'customerName'], where: { zohoCustomerId: { not: null }, status: { notIn: ['void'] } }, _count: { _all: true }, _max: { orderDate: true }, _sum: { total: true } });
    const cutoff = daysAgo(a.inactiveDays);
    const candidates = grouped.filter((g) => g._count._all >= a.minOrders && g._max.orderDate && g._max.orderDate < cutoff).sort((x, y) => num(y._sum.total) - num(x._sum.total)).slice(0, a.limit);
    const result = [];
    for (const g of candidates) {
      const [contact, topItems] = await Promise.all([
        prisma.contact.findUnique({ where: { zohoContactId: g.zohoCustomerId as string }, select: { primaryPhone: true, mobile: true, primaryEmail: true } }),
        prisma.salesOrderItem.groupBy({ by: ['name'], where: { salesOrder: { zohoCustomerId: g.zohoCustomerId } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 3 }),
      ]);
      result.push({ customer: g.customerName, zohoCustomerId: g.zohoCustomerId, orders: g._count._all, lifetimeTotal: Math.round(num(g._sum.total) * 100) / 100, lastOrder: g._max.orderDate?.toISOString().slice(0, 10), daysInactive: g._max.orderDate ? Math.round((Date.now() - g._max.orderDate.getTime()) / 86_400_000) : null, usuallyBuys: topItems.map((i) => i.name).filter(Boolean), phone: normalizePhone(contact?.primaryPhone ?? contact?.mobile ?? null), email: contact?.primaryEmail ?? null });
    }
    return { count: result.length, customers: result, note: 'Propón al usuario un mensaje de reactivación personalizado por cliente (sendBulkMessages con aprobación).' };
  },
});

// ---------------------------------------------------------------------------
// 8. Price history for a customer/product
// ---------------------------------------------------------------------------
registerTool({
  name: 'getCustomerPriceHistory',
  description: 'Últimos precios a los que un cliente compró o se le cotizó un producto (para cotizar consistente). Busca en órdenes de venta y cotizaciones.',
  category: 'sales',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ customer: z.string().min(1), product: z.string().min(2).describe('Nombre o SKU (parcial)'), limit: z.number().int().min(1).max(20).default(8) }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { customer: string; product: string; limit: number };
    const c = await resolveCustomer(a.customer);
    const soWhere: Prisma.SalesOrderWhereInput = c.zohoCustomerId ? { zohoCustomerId: c.zohoCustomerId } : { customerName: { contains: c.name, mode: 'insensitive' } };
    const [soItems, quoteItems] = await Promise.all([
      prisma.salesOrderItem.findMany({ where: { salesOrder: soWhere, OR: [{ name: { contains: a.product, mode: 'insensitive' } }, { sku: { contains: a.product, mode: 'insensitive' } }] }, orderBy: { salesOrder: { orderDate: 'desc' } }, take: a.limit, select: { name: true, sku: true, quantity: true, rate: true, unit: true, salesOrder: { select: { salesOrderNumber: true, orderDate: true } } } }),
      prisma.quoteItem.findMany({ where: { quote: c.zohoCustomerId ? { zohoCustomerId: c.zohoCustomerId } : { customerName: { contains: c.name, mode: 'insensitive' } }, OR: [{ name: { contains: a.product, mode: 'insensitive' } }, { sku: { contains: a.product, mode: 'insensitive' } }] }, orderBy: { quote: { date: 'desc' } }, take: a.limit, select: { name: true, sku: true, quantity: true, rate: true, unit: true, quote: { select: { estimateNumber: true, date: true, status: true } } } }),
    ]);
    return {
      customer: c.name,
      sales: soItems.map((i) => ({ folio: i.salesOrder.salesOrderNumber, date: i.salesOrder.orderDate?.toISOString().slice(0, 10), product: i.name, sku: i.sku, quantity: num(i.quantity), unit: i.unit, rate: num(i.rate) })),
      quotes: quoteItems.map((i) => ({ folio: i.quote.estimateNumber, date: i.quote.date?.toISOString().slice(0, 10), status: i.quote.status, product: i.name, sku: i.sku, quantity: num(i.quantity), unit: i.unit, rate: num(i.rate) })),
      note: soItems.length === 0 && quoteItems.length === 0 ? 'Sin historial para ese cliente/producto: usa el precio de lista del catálogo.' : 'Usa el último precio de venta como referencia salvo que el usuario indique otro.',
    };
  },
});

// ---------------------------------------------------------------------------
// 9. Artifact spec (report revisions)
// ---------------------------------------------------------------------------
registerTool({
  name: 'getArtifactSpec',
  description: 'Devuelve cómo se generó un reporte anterior (tool de datos, filtros, columnas, título, secciones) para reproducirlo con cambios ("agrégale el vendedor", "solo las pagadas"). Úsalo antes de rehacer un reporte que ya enviaste.',
  category: 'export',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ artifactId: z.string().optional().describe('Id del artefacto; vacío = el más reciente del usuario') }),
  execute: async (actor, rawArgs) => {
    const { artifactId } = rawArgs as { artifactId?: string };
    const artifact = artifactId
      ? await prisma.aiArtifact.findFirst({ where: { id: artifactId, conversation: { userId: actor.id } } })
      : await prisma.aiArtifact.findFirst({ where: { conversation: { userId: actor.id }, type: { in: ['pdf', 'xlsx', 'docx', 'csv'] } }, orderBy: { createdAt: 'desc' } });
    if (!artifact) return { error: 'No encontré ese reporte' };
    const meta = (artifact.meta as Record<string, unknown> | null) ?? {};
    return {
      artifactId: artifact.id,
      type: artifact.type,
      title: meta.title,
      createdAt: artifact.createdAt.toISOString(),
      spec: meta.spec ?? null,
      note: meta.spec ? 'Reproduce: llama sourceTool con sourceArgs (ajustando lo que pidió el usuario) y luego generatedBy con generatorArgs modificados. Conserva título/columnas salvo que pidan cambiarlos.' : 'Este reporte no guardó su especificación; pregunta qué contenía o regenéralo desde cero.',
    };
  },
});

// ---------------------------------------------------------------------------
// 10. Chat calendar event
// ---------------------------------------------------------------------------
registerTool({
  name: 'createChatEvent',
  description: 'Crea un evento en la agenda del chat interno (visible para los miembros del canal): reuniones, entregas programadas, visitas.',
  category: 'communication',
  requiredPermission: 'chat.use',
  enabledByDefault: true,
  effect: 'internal_task',
  summarize: (args) => `Crear evento "${(args as { title: string }).title}" en el chat`,
  parameters: z.object({
    chatChannelId: z.string().min(1),
    title: z.string().min(2).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    location: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
  }),
  execute: async (actor, rawArgs) => {
    const a = rawArgs as { chatChannelId: string; title: string; startsAt: string; endsAt?: string; location?: string; description?: string };
    const { sendMessage } = await import('@/modules/chat/chat-service');
    const message = await sendMessage(actor, { channelId: a.chatChannelId, content: null, event: { title: a.title, description: a.description, startsAt: a.startsAt, endsAt: a.endsAt ?? null, location: a.location ?? null } });
    return { messageId: message.id, eventId: message.event?.id ?? null, title: a.title, startsAt: a.startsAt };
  },
});

// ---------------------------------------------------------------------------
// 11. Satisfaction survey draft
// ---------------------------------------------------------------------------
registerTool({
  name: 'draftSatisfactionSurvey',
  description: 'Prepara un mensaje corto de encuesta de satisfacción para un pedido entregado (calificación 1-5 y comentario), con el teléfono del cliente, listo para sendMessageToContact.',
  category: 'communication',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({ salesOrderNumber: z.string().min(1) }),
  execute: async (_actor, rawArgs) => {
    const { salesOrderNumber } = rawArgs as { salesOrderNumber: string };
    const order = await prisma.salesOrder.findFirst({ where: { salesOrderNumber: { contains: salesOrderNumber, mode: 'insensitive' } }, select: { salesOrderNumber: true, customerName: true, customerPhone: true, salespersonName: true } });
    if (!order) return { error: 'Pedido no encontrado' };
    const phone = normalizePhone(order.customerPhone);
    return {
      contact: phone ?? order.customerName,
      phone,
      customer: order.customerName,
      body: `Hola ${order.customerName ?? ''} 👋 Gracias por su compra (pedido ${order.salesOrderNumber}). ¿Nos ayuda con una calificación del 1 al 5 sobre la entrega y el producto? Cualquier comentario nos sirve para mejorar. ¡Gracias!${order.salespersonName ? ` — ${order.salespersonName}, UNIK` : ''}`,
      note: 'Envíalo con sendMessageToContact tras la aprobación del usuario.',
    };
  },
});

// ---------------------------------------------------------------------------
// 12. Work digest
// ---------------------------------------------------------------------------
registerTool({
  name: 'getWorkDigest',
  description: 'Resumen del trabajo del usuario (o de otro usuario si tienes permiso de usuarios) para un día: qué hizo con la IA, mensajes enviados, compromisos, cotizaciones, ventas como vendedor y KPIs, con una narrativa. Responde "¿cómo voy hoy?", "¿qué hizo Juan ayer?".',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ userName: z.string().optional().describe('Otro usuario (requiere users.view)'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('yyyy-mm-dd; por defecto hoy') }),
  execute: async (actor, rawArgs) => {
    const a = rawArgs as { userName?: string; date?: string };
    const { computeUserDigest, getUserDigest } = await import('../ai-digest-service');
    let userId = actor.id;
    let name = actor.name;
    if (a.userName) {
      const can = actor.isSuperAdmin || (actor.permissionKeys as string[]).includes('users.view');
      if (!can) return { error: 'No tienes permiso para ver el trabajo de otros usuarios' };
      const user = await prisma.user.findFirst({ where: { OR: [{ name: { contains: a.userName, mode: 'insensitive' } }, { username: { equals: a.userName, mode: 'insensitive' } }] }, select: { id: true, name: true } });
      if (!user) return { error: `Usuario "${a.userName}" no encontrado` };
      userId = user.id;
      name = user.name;
    }
    const date = a.date ?? new Date().toISOString().slice(0, 10);
    const stored = await getUserDigest(userId, date);
    const digest = stored ?? (await computeUserDigest(userId, date, { persist: true, narrate: true }));
    return { user: name, date, ...digest };
  },
});

// ---------------------------------------------------------------------------
// 13. Deal blockers for one order
// ---------------------------------------------------------------------------
registerTool({
  name: 'getDealBlockers',
  description: 'Qué falta para cerrar/entregar un pedido específico: pago, dirección, paquete, retraso, notas del cliente. Devuelve las banderas y el siguiente paso concreto.',
  category: 'sales',
  requiredPermission: SALES_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ salesOrderNumber: z.string().min(1) }),
  execute: async (_actor, rawArgs) => {
    const { salesOrderNumber } = rawArgs as { salesOrderNumber: string };
    const order = await prisma.salesOrder.findFirst({ where: { salesOrderNumber: { contains: salesOrderNumber, mode: 'insensitive' } } });
    if (!order) return { error: 'Pedido no encontrado' };
    const { getPackagesBySalesOrderZohoId } = await import('@/modules/cross-module/relationships-service');
    const packages = await getPackagesBySalesOrderZohoId(order.zohoSalesOrderId, 10, order.salesOrderNumber).catch(() => []);
    const audit = auditPendingDelivery(
      { salesOrderNumber: order.salesOrderNumber, orderDate: order.orderDate, status: order.status, paidStatus: order.paidStatus, shippedStatus: order.shippedStatus, paymentMethod: order.paymentMethod, deliveryMethod: order.deliveryMethod, shippingAddressLine1: order.shippingAttention, shippingCity: order.shippingCity, shippingState: order.shippingState, notes: order.notes, total: order.total, balance: order.balance },
      { today: new Date(), staleDays: 3, highTotalThreshold: null, packages: packages.map((p) => ({ packageNumber: p.packageNumber, status: p.status })) }
    );
    const ticket = ticketOf(order);
    const nextSteps: string[] = [];
    if (num(order.balance) > 0) nextSteps.push(`Cobrar saldo de $${num(order.balance).toLocaleString('es-MX', { minimumFractionDigits: 2 })}.`);
    if (!order.shippingCity && !/recoge|bodega|pick/i.test(order.deliveryMethod ?? '')) nextSteps.push('Confirmar dirección de entrega con el cliente.');
    if (packages.length === 0 && ticket !== 'Cerrado') nextSteps.push('Crear el paquete/envío en Zoho.');
    return { folio: order.salesOrderNumber, customer: order.customerName, ticket, daysOpen: audit.daysOpen, balance: num(order.balance), total: num(order.total), deliveryMethod: order.deliveryMethod, packages: packages.map((p) => ({ number: p.packageNumber, status: p.status })), flags: audit.flags, score: audit.score, nextSteps };
  },
});
