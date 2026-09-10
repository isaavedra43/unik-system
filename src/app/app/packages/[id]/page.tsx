import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getPackageById } from '@/modules/packages/packages-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { PACKAGE_ENTITY_TYPE } from '@/modules/packages/permissions';
import { PackageDetailPage } from '@/components/packages/PackageDetailPage';
import { getContactByZohoId, getInvoicesBySalesOrderZohoId } from '@/modules/cross-module/relationships-service';
import { watchAction, unwatchAction } from '../actions';

export const runtime = 'nodejs';

export default async function PackageDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) notFound();
  const { id } = await params;
  const pkg = await getPackageById(id);
  if (!pkg) notFound();
  const isWatched = await isEntityWatched(session!.user.id, PACKAGE_ENTITY_TYPE, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('packages.watch');

  // Fetch related contact (customer)
  let relatedContact = null;
  try {
    relatedContact = pkg!.zohoCustomerId ? await getContactByZohoId(pkg!.zohoCustomerId) : null;
  } catch (error) {
    console.error('Error loading related contact for package:', error);
  }

  // Fetch related sales order (by zohoSalesOrderId)
  let relatedSalesOrder: { id: string; salesOrderNumber: string | null; status: string | null; total: string | null } | null = null;
  if (pkg!.zohoSalesOrderId) {
    try {
      const { prisma } = await import('@/lib/prisma');
      const so = await prisma.salesOrder.findUnique({
        where: { zohoSalesOrderId: pkg!.zohoSalesOrderId },
        select: { id: true, salesOrderNumber: true, status: true, total: true },
      });
      if (so) {
        relatedSalesOrder = {
          id: so.id,
          salesOrderNumber: so.salesOrderNumber,
          status: so.status,
          total: so.total?.toString() ?? null,
        };
      }
    } catch (error) {
      console.error('Error loading related sales order for package:', error);
    }
  }

  // Fetch related invoices (invoices that have items with this sales order ID)
  let relatedInvoices: { id: string; invoiceNumber: string | null; status: string | null; total: string | null; date: string | null }[] = [];
  if (pkg!.zohoSalesOrderId) {
    try {
      const invoices = await getInvoicesBySalesOrderZohoId(pkg!.zohoSalesOrderId);
      relatedInvoices = invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        total: inv.total,
        date: inv.date,
      }));
    } catch (error) {
      console.error('Error loading related invoices for package:', error);
    }
  }

  return (
    <PackageDetailPage pkg={pkg!} entityLabel="Paquete" entityLabelPlural="Paquetes"
      basePath="/app/packages" isWatched={isWatched} canWatch={canWatch}
      watchAction={watchAction} unwatchAction={unwatchAction} relatedContact={relatedContact}
      relatedSalesOrder={relatedSalesOrder} relatedInvoices={relatedInvoices} />
  );
}
