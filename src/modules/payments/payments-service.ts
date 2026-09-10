import { prisma } from '@/lib/prisma';
import { toPaymentListRow, toPaymentDetail } from './payments-contract';
import type { PaymentListRow, PaymentDetail } from './payments-contract';

export type { PaymentListRow, PaymentDetail };

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface PaymentsListResult {
  rows: PaymentListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function isPrismaTableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('does not exist') ||
      msg.includes('relation') ||
      msg.includes('p2021') ||
      msg.includes('the table') ||
      msg.includes('no such table')
    );
  }
  return false;
}

export async function getPaymentsWorkspace(options: {
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<PaymentsListResult> {
  const page = Math.max(MIN_PAGE, options.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
  const search = options.search?.trim();

  const where = search
    ? {
        OR: [
          { paymentNumber: { contains: search, mode: 'insensitive' as const } },
          { customerName: { contains: search, mode: 'insensitive' as const } },
          { referenceNumber: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  try {
    const [rows, total] = await Promise.all([
      prisma.customerPayment.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.customerPayment.count({ where }),
    ]);

    return {
      rows: rows.map(toPaymentListRow),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('CustomerPayment table not available — migration may not be applied:', error);
      return { rows: [], total: 0, page, pageSize, totalPages: 0 };
    }
    throw error;
  }
}

export async function getPaymentById(id: string): Promise<PaymentDetail | null> {
  try {
    const payment = await prisma.customerPayment.findUnique({ where: { id } });
    if (!payment) return null;
    return toPaymentDetail(payment);
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('CustomerPayment table not available — migration may not be applied:', error);
      return null;
    }
    throw error;
  }
}
