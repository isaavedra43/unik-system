import { redirect } from 'next/navigation';
export default async function LegacyStockTraceRedirect({
  params,
}: {
  params: Promise<{ stockItemId: string }>;
}) {
  redirect(`/app/areas/manufactura/trazabilidad/${encodeURIComponent((await params).stockItemId)}`);
}
