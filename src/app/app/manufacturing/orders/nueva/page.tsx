import { redirect } from 'next/navigation';
export default function LegacyNewProductionOrderRedirect() {
  redirect('/app/areas/manufactura/ordenes/nueva');
}
