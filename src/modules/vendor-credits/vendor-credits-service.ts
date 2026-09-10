import { prisma } from '@/lib/prisma';
import { toVendorCreditListRow, toVendorCreditDetail } from './vendor-credits-contract';
import type { VendorCreditListRow, VendorCreditDetail } from './vendor-credits-contract';

export type { VendorCreditListRow, VendorCreditDetail };

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface VendorCreditsListResult {
  rows: VendorCreditListRow[];
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

export async function getVendorCreditsWorkspace(options: {
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<VendorCreditsListResult> {
  const page = Math.max(MIN_PAGE, options.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
  const search = options.search?.trim();

  const where = search
    ? {
        OR: [
          { vendorCreditNumber: { contains: search, mode: 'insensitive' as const } },
          { vendorName: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  try {
    const [rows, total] = await Promise.all([
      prisma.vendorCredit.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.vendorCredit.count({ where }),
    ]);

    return {
      rows: rows.map(toVendorCreditListRow),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('VendorCredit table not available — migration may not be applied:', error);
      return { rows: [], total: 0, page, pageSize, totalPages: 0 };
    }
    throw error;
  }
}

export async function getVendorCreditById(id: string): Promise<VendorCreditDetail | null> {
  try {
    const vendorCredit = await prisma.vendorCredit.findUnique({ where: { id } });
    if (!vendorCredit) return null;
    return toVendorCreditDetail(vendorCredit);
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('VendorCredit table not available — migration may not be applied:', error);
      return null;
    }
    throw error;
  }
}
