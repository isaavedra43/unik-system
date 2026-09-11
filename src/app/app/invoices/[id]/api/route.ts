import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getInvoiceById } from '@/modules/invoices/invoices-service';
import { getInvoiceRelations } from '@/modules/cross-module/relationships-service';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('invoices.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  const invoice = await getInvoiceById(id);
  if (!invoice) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  const relations = await getInvoiceRelations(invoice.id, invoice.zohoCustomerId);
  return NextResponse.json({
    ...invoice,
    relatedSalesOrders: relations.salesOrders,
    relatedPayments: relations.payments,
    relatedContact: relations.contact,
  });
}
