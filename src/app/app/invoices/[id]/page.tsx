import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getInvoiceById } from '@/modules/invoices/invoices-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { INVOICE_ENTITY_TYPE } from '@/modules/invoices/permissions';
import { InvoiceDetailPage } from '@/components/invoices/InvoiceDetailPage';
import { getContactByZohoId } from '@/modules/cross-module/relationships-service';
import { watchAction, unwatchAction } from '../actions';

export const runtime = 'nodejs';

export default async function InvoiceDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) notFound();
  const { id } = await params;
  const invoice = await getInvoiceById(id);
  if (!invoice) notFound();
  const isWatched = await isEntityWatched(session!.user.id, INVOICE_ENTITY_TYPE, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('invoices.watch');
  const relatedContact = invoice!.zohoCustomerId ? await getContactByZohoId(invoice!.zohoCustomerId) : null;
  return (
    <InvoiceDetailPage invoice={invoice!} entityLabel="Factura" entityLabelPlural="Facturas"
      basePath="/app/invoices" isWatched={isWatched} canWatch={canWatch}
      watchAction={watchAction} unwatchAction={unwatchAction} relatedContact={relatedContact} />
  );
}
