import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getBillById } from '@/modules/bills/bills-service';
import { getBillRelations } from '@/modules/cross-module/relationships-service';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (!hasPermission(session.user, 'bills.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const bill = await getBillById(id);
  if (!bill) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  const relations = await getBillRelations(bill.zohoPurchaseOrderId, bill.zohoVendorId);
  return NextResponse.json({
    ...bill,
    relatedPurchaseOrder: relations.purchaseOrder,
    relatedContact: relations.contact,
    relatedVendorCredits: relations.vendorCredits,
  });
}
