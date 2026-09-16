import { redirect } from 'next/navigation';
export default async function LegacyProductionOrderRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  redirect(`/app/areas/manufactura/ordenes/${encodeURIComponent((await params).id)}`);
}
