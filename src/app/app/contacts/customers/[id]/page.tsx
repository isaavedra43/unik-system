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
  let contact;
  try {
    contact = await getContactById(id);
  } catch (error) {
    console.error('Error loading customer contact:', error);
    notFound();
  }
  if (!contact) {
    notFound();
  }

  const isWatched = await isEntityWatched(session!.user.id, CONTACT_ENTITY_TYPE_CUSTOMER, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('customers.watch');

  let relatedPackages: Awaited<ReturnType<typeof getPackagesByContactZohoId>> = [];
  let relatedInvoices: Awaited<ReturnType<typeof getInvoicesByContactZohoId>> = [];
  let relatedSalesOrders: Awaited<ReturnType<typeof getSalesOrdersByContactZohoId>> = [];
  let relatedPayments: Awaited<ReturnType<typeof getPaymentsByContactZohoId>> = [];
  try {
    [relatedPackages, relatedInvoices, relatedSalesOrders, relatedPayments] = await Promise.all([
      getPackagesByContactZohoId(contact!.zohoContactId),
      getInvoicesByContactZohoId(contact!.zohoContactId),
      getSalesOrdersByContactZohoId(contact!.zohoContactId),
      getPaymentsByContactZohoId(contact!.zohoContactId),
    ]);
  } catch (error) {
    console.error('Error loading customer relationships:', error);
  }

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
