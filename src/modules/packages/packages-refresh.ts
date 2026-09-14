import { getPackageById } from './packages-service';
import type { PackageDetail } from './packages-contract';
import { refreshPackageOnDemand } from '@/modules/integrations/zoho/packages-shipment-sweep';

/**
 * Loads a package for display, refreshing it from Zoho first when the stored
 * row may be behind (see `packageNeedsRefresh`). One bounded Zoho call; when
 * Zoho is busy or fails, the stored row is returned with the outcome attached
 * so the UI can say so instead of showing stale data silently.
 */
export async function getPackageForDisplay(
  id: string,
  options: { force?: boolean } = {}
): Promise<PackageDetail | null> {
  const stored = await getPackageById(id);
  if (!stored) return null;
  const outcome = await refreshPackageOnDemand(id, options);
  const pkg = outcome.status === 'refreshed' ? ((await getPackageById(id)) ?? stored) : stored;
  return {
    ...pkg,
    zohoRefresh:
      outcome.status === 'refreshed'
        ? { status: 'refreshed', at: outcome.at.toISOString() }
        : outcome.status === 'failed'
          ? { status: 'failed', error: outcome.error }
          : { status: outcome.status },
  };
}
