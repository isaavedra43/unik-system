import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { CONTACT_ENTITY_TYPE_CUSTOMER } from '@/modules/contacts/permissions';
import { ContactDetailPage } from '@/components/contacts/ContactDetailPage';
import {
  getPackagesByContactZohoId,
  getInvoicesByContactZohoId,
  getSalesOrdersByContactZohoId,
  getPaymentsByContactZohoId,
} from '@/modules/cross-module/relationships-service';
import { watchAction, unwatchAction } from '../actions';

export const runtime = 'nodejs';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) {
    notFound();
  }

  const { id } = await params;
  const contact = await getContactById(id);
  if (!contact) {
    notFound();
  }

  const isWatched = await isEntityWatched(session!.user.id, CONTACT_ENTITY_TYPE_CUSTOMER, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('customers.watch');

  const [relatedPackages, relatedInvoices, relatedSalesOrders, relatedPayments] = await Promise.all([
    getPackagesByContactZohoId(contact!.zohoContactId),
    getInvoicesByContactZohoId(contact!.zohoContactId),
    getSalesOrdersByContactZohoId(contact!.zohoContactId),
    getPaymentsByContactZohoId(contact!.zohoContactId),
  ]);

  return (
    <ContactDetailPage
      contact={contact!}
      entityLabel="Cliente"
      entityLabelPlural="Clientes"
      basePath="/app/contacts/customers"
      isWatched={isWatched}
      canWatch={canWatch}
      watchAction={watchAction}
      unwatchAction={unwatchAction}
      relatedPackages={relatedPackages}
      relatedInvoices={relatedInvoices}
      relatedSalesOrders={relatedSalesOrders}
      relatedPayments={relatedPayments}
    />
  );
}
