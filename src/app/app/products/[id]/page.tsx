import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getProductById } from '@/modules/products/products-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { PRODUCT_ENTITY_TYPE } from '@/modules/products/permissions';
import { ProductDetailPage } from '@/components/products/ProductDetailPage';
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
    />
  );
}
