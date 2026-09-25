/**
 * Pure normalization for the Composio toolkit catalog (admin grid). No I/O —
 * safe to unit test and reuse.
 *
 * Raw shape: GET {base}/api/v3.1/toolkits returns snake_case items
 * (`meta.tools_count`, `auth_schemes`, `composio_managed_auth_schemes`…).
 */

export interface RawToolkitItem {
  slug?: string;
  name?: string;
  logo?: string | null;
  no_auth?: boolean;
  auth_schemes?: string[] | null;
  composio_managed_auth_schemes?: string[] | null;
  meta?: {
    description?: string | null;
    logo?: string | null;
    app_url?: string | null;
    tools_count?: number | null;
    categories?: Array<{ slug?: string; name?: string }> | null;
  } | null;
}

export interface CatalogToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  /** Composio auth schemes, uppercased, e.g. ['OAUTH2', 'API_KEY']. */
  authSchemes: string[];
  /** Schemes where Composio manages the OAuth app itself (zero admin config). */
  managedAuthSchemes: string[];
  toolsCount: number;
  /** Vendor app URL (docs / signup), when Composio provides it. */
  appUrl: string | null;
  noAuth: boolean;
}

/** Normalize one raw toolkit; returns null when it has no usable identity. */
export function normalizeCatalogItem(t: RawToolkitItem): CatalogToolkit | null {
  const slug = t.slug?.trim().toLowerCase();
  const name = t.name?.trim();
  if (!slug || !name) return null;
  return {
    slug,
    name,
    description: t.meta?.description?.slice(0, 200) ?? '',
    logo: t.meta?.logo ?? t.logo ?? null,
    categories: (t.meta?.categories ?? []).map((c) => c.name?.trim()).filter(Boolean) as string[],
    authSchemes: (t.auth_schemes ?? []).map((s) => s.toUpperCase()),
    managedAuthSchemes: (t.composio_managed_auth_schemes ?? []).map((s) => s.toUpperCase()),
    toolsCount: Math.max(0, t.meta?.tools_count ?? 0),
    appUrl: t.meta?.app_url ?? null,
    noAuth: Boolean(t.no_auth),
  };
}

/** Merge pages of raw items into a deduped catalog (first occurrence wins). */
export function mergeCatalogItems(rawItems: RawToolkitItem[]): CatalogToolkit[] {
  const seen = new Set<string>();
  const items: CatalogToolkit[] = [];
  for (const raw of rawItems) {
    const item = normalizeCatalogItem(raw);
    if (item && !seen.has(item.slug)) {
      seen.add(item.slug);
      items.push(item);
    }
  }
  return items;
}
