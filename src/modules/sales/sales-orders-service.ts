import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const salesOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(MIN_PAGE).default(MIN_PAGE),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  status: z.string().optional(),
  salesperson: z.string().optional(),
  payment_method: z.string().optional(),
  delivery_method: z.string().optional(),
  location: z.string().optional(),
  search: z.string().optional(),
});

export type SalesOrderListQuery = z.output<typeof salesOrderListQuerySchema>;

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toString();
}

function formatListItem(order: {
  id: string;
  salesOrderNumber: string | null;
  orderDate: Date | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  locationName: string | null;
  status: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  total: Prisma.Decimal | null;
  currencyCode: string | null;
}) {
  return {
    id: order.id,
    sales_order_number: order.salesOrderNumber,
    order_date: order.orderDate?.toISOString().split('T')[0] ?? null,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    salesperson_name: order.salespersonName,
    payment_method: order.paymentMethod,
    delivery_method: order.deliveryMethod,
    location_name: order.locationName,
    status: order.status,
    paid_status: order.paidStatus,
    invoiced_status: order.invoicedStatus,
    shipped_status: order.shippedStatus,
    total: decimalToString(order.total),
    currency_code: order.currencyCode,
  };
}

function buildWhere(query: SalesOrderListQuery): Prisma.SalesOrderWhereInput {
  const where: Prisma.SalesOrderWhereInput = {};

  if (query.date_from) {
    where.orderDate = { gte: query.date_from };
  }

  if (query.date_to) {
    where.orderDate = { ...(where.orderDate as object), lte: query.date_to };
  }

  if (query.status) {
    where.status = { contains: query.status, mode: 'insensitive' };
  }

  if (query.salesperson) {
    where.salespersonName = { contains: query.salesperson, mode: 'insensitive' };
  }

  if (query.payment_method) {
    where.paymentMethod = { contains: query.payment_method, mode: 'insensitive' };
  }

  if (query.delivery_method) {
    where.deliveryMethod = { contains: query.delivery_method, mode: 'insensitive' };
  }

  if (query.location) {
    where.locationName = { contains: query.location, mode: 'insensitive' };
  }

  if (query.search && query.search.length > 0) {
    where.OR = [
      { salesOrderNumber: { contains: query.search, mode: 'insensitive' } },
      { customerName: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  return where;
}

export async function getSalesOrdersList(query: SalesOrderListQuery) {
  const where = buildWhere(query);
  const skip = (query.page - MIN_PAGE) * query.page_size;

  const [orders, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      orderBy: { orderDate: 'desc' },
      take: query.page_size,
      skip,
      select: {
        id: true,
        salesOrderNumber: true,
        orderDate: true,
        customerName: true,
        customerPhone: true,
        salespersonName: true,
        paymentMethod: true,
        deliveryMethod: true,
        locationName: true,
        status: true,
        paidStatus: true,
        invoicedStatus: true,
        shippedStatus: true,
        total: true,
        currencyCode: true,
      },
    }),
    prisma.salesOrder.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.page_size);

  return {
    data: orders.map(formatListItem),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: totalPages,
    },
  };
}

function formatDetailItem(item: {
  id: string;
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string | null;
  description: string | null;
  quantity: Prisma.Decimal | null;
  unit: string | null;
  rate: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  taxName: string | null;
  taxPercentage: Prisma.Decimal | null;
  taxAmount: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal | null;
  locationId: string | null;
  locationName: string | null;
  sortOrder: number;
}) {
  return {
    id: item.id,
    zoho_line_item_id: item.zohoLineItemId,
    zoho_item_id: item.zohoItemId,
    sku: item.sku,
    name: item.name,
    description: item.description,
    quantity: decimalToString(item.quantity),
    unit: item.unit,
    rate: decimalToString(item.rate),
    discount_amount: decimalToString(item.discountAmount),
    tax_name: item.taxName,
    tax_percentage: decimalToString(item.taxPercentage),
    tax_amount: decimalToString(item.taxAmount),
    line_total: decimalToString(item.lineTotal),
    location_id: item.locationId,
    location_name: item.locationName,
    sort_order: item.sortOrder,
  };
}

export async function getSalesOrderById(id: string) {
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });

  if (!order) {
    return null;
  }

  return {
    id: order.id,
    zoho_sales_order_id: order.zohoSalesOrderId,
    sales_order_number: order.salesOrderNumber,
    reference_number: order.referenceNumber,
    order_date: order.orderDate?.toISOString().split('T')[0] ?? null,
    created_time: order.createdTime?.toISOString() ?? null,
    status: order.status,
    sub_status: order.subStatus,
    paid_status: order.paidStatus,
    invoiced_status: order.invoicedStatus,
    shipped_status: order.shippedStatus,
    zoho_customer_id: order.zohoCustomerId,
    customer_name: order.customerName,
    customer_email: order.customerEmail,
    customer_phone: order.customerPhone,
    zoho_salesperson_id: order.zohoSalespersonId,
    salesperson_name: order.salespersonName,
    payment_method: order.paymentMethod,
    delivery_method: order.deliveryMethod,
    delivery_method_id: order.deliveryMethodId,
    location_id: order.locationId,
    location_name: order.locationName,
    branch_id: order.branchId,
    branch_name: order.branchName,
    shipping_attention: order.shippingAttention,
    shipping_address_line_1: order.shippingAddressLine1,
    shipping_address_line_2: order.shippingAddressLine2,
    shipping_city: order.shippingCity,
    shipping_state: order.shippingState,
    shipping_postal_code: order.shippingPostalCode,
    shipping_country: order.shippingCountry,
    shipping_phone: order.shippingPhone,
    currency_code: order.currencyCode,
    subtotal: decimalToString(order.subtotal),
    discount_total: decimalToString(order.discountTotal),
    tax_total: decimalToString(order.taxTotal),
    shipping_charge: decimalToString(order.shippingCharge),
    adjustment: decimalToString(order.adjustment),
    total: decimalToString(order.total),
    balance: decimalToString(order.balance),
    notes: order.notes,
    sale_made_in_warehouse: order.saleMadeInWarehouse,
    source_remote_modified_at: order.sourceRemoteModifiedAt.toISOString(),
    source_snapshot_id: order.sourceSnapshotId,
    normalized_at: order.normalizedAt.toISOString(),
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
    items: order.items.map(formatDetailItem),
  };
}
