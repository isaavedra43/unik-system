import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getProductById } from '@/modules/products/products-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { PRODUCT_ENTITY_TYPE } from '@/modules/products/permissions';
import { ProductDetailPage } from '@/components/products/ProductDetailPage';
import {
  getProductSalesOrderHistory,
  getProductInvoiceHistory,
  getProductPackageHistory,
} from '@/modules/cross-module/relationships-service';
import { watchAction, unwatchAction } from '../actions';

export const runtime = 'nodejs';

export default async function ProductDetailPageRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) {
    notFound();
  }

  const { id } = await params;
  const product = await getProductById(id);
  if (!product) {
    notFound();
  }

  const isWatched = await isEntityWatched(session!.user.id, PRODUCT_ENTITY_TYPE, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('products.watch');

  const [salesOrderHistory, invoiceHistory, packageHistory] = await Promise.all([
    getProductSalesOrderHistory(product!.zohoItemId),
    getProductInvoiceHistory(product!.zohoItemId),
    getProductPackageHistory(product!.zohoItemId),
  ]);

  // Find vendor contact by zohoVendorId
  let vendorId: string | null = null;
  let vendorName: string | null = null;
  if (product!.zohoVendorId) {
    const { prisma } = await import('@/lib/prisma');
    const vendor = await prisma.contact.findUnique({
      where: { zohoContactId: product!.zohoVendorId },
      select: { id: true, contactName: true },
    });
    if (vendor) {
      vendorId = vendor.id;
      vendorName = vendor.contactName;
    }
  }

  return (
    <ProductDetailPage
      product={product!}
      entityLabel="Producto"
      entityLabelPlural="Productos"
      basePath="/app/products"
      isWatched={isWatched}
      canWatch={canWatch}
      watchAction={watchAction}
      unwatchAction={unwatchAction}
      salesOrderHistory={salesOrderHistory}
      invoiceHistory={invoiceHistory}
      packageHistory={packageHistory}
      vendorId={vendorId}
      vendorName={vendorName}
    />
  );
}
