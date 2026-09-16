import type { CurrentUser } from '@/modules/auth/authorization';
import { scanStockCode } from '@/modules/inventory/inventory-queries';
import { CONFIDENCE_LABELS, type ConfidenceLevel } from '@/modules/inventory/inventory-types';
import type { ScanResolution, ScannedStockItem } from '@/modules/inventory/labels-service';

/**
 * Scan resolution for the operational surfaces (plan 7.10): the mobile bar,
 * the counting PWA and anything else that reads a QR, a container label, a
 * location code or a SKU.
 *
 * It does NOT re-implement the lookup: `resolveScan` of the inventory module
 * is the only place that knows how a code maps to stock, and `scanStockCode`
 * is the one that checks `inventory.view | inventory.count | inventory.manage`
 * before reading anything. This module only turns that answer into the small,
 * already-formatted shape the UI shows, so the client never receives rows it
 * is not allowed to see and never formats decimals on its own.
 *
 * `describeScan` is pure (no Prisma, no I/O): the unit test drives it directly.
 */

/** Longest code accepted (the parser of the inventory module clips at the same length). */
export const SCAN_MAX_LENGTH = 200;
/** Stock rows shown for a location or a SKU; the rest is announced as "y N más". */
export const SCAN_MAX_ITEMS = 20;

/**
 * Deep link of the inventory map with the scanned code. It must stay equal to
 * `areaHref('inventario', AREA_REGISTRY.inventario.special.slug)`; the unit
 * test compares both so a renamed space cannot rot this link.
 */
export const INVENTORY_SCAN_PATH = '/app/areas/inventario/mapa';

export type ScanMatchKind = 'stock_item' | 'location' | 'sku' | 'unknown';

export interface ScanItem {
  /** StockItem id. */
  id: string;
  title: string;
  subtitle: string;
  /** Available quantity, already formatted in es-MX. */
  quantity: string;
  unit: string | null;
  locationCode: string | null;
  confidenceLabel: string;
}

export interface ScanLookup {
  /** What was scanned or typed (trimmed and clipped). */
  code: string;
  kind: ScanMatchKind;
  title: string;
  subtitle: string;
  items: ScanItem[];
  /** Rows beyond `SCAN_MAX_ITEMS`. */
  moreItems: number;
  /** Where to open the whole picture, or null when there is nothing to open. */
  href: string | null;
  /** Why there is no match (only for `unknown`). */
  message: string | null;
}

/** Trims, collapses spaces and clips a scanned code. */
export function normalizeScanCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, SCAN_MAX_LENGTH) : '';
}

function formatQuantity(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString('es-MX', { maximumFractionDigits: 3 });
}

function confidenceLabel(confidence: ConfidenceLevel): string {
  return CONFIDENCE_LABELS[confidence] ?? 'Sin contar';
}

function itemTitle(item: ScannedStockItem): string {
  return item.productName ?? item.sku ?? item.containerKey ?? item.zohoItemId;
}

function toItem(item: ScannedStockItem): ScanItem {
  const parts = [
    item.containerKey || null,
    item.variantLabel || null,
    item.locationCode ? `Ubicación ${item.locationCode}` : null,
  ].filter((part): part is string => Boolean(part));
  return {
    id: item.id,
    title: itemTitle(item),
    subtitle: parts.join(' · '),
    quantity: formatQuantity(item.available),
    unit: item.baseUnit,
    locationCode: item.locationCode,
    confidenceLabel: confidenceLabel(item.confidence),
  };
}

function countLabel(total: number): string {
  if (total === 0) return 'Sin existencias registradas';
  return total === 1 ? '1 registro de existencia' : `${total} registros de existencia`;
}

function scanHref(code: string): string {
  return `${INVENTORY_SCAN_PATH}?scan=${encodeURIComponent(code)}`;
}

/** Turns the inventory answer into what the UI shows. PURE. */
export function describeScan(resolution: ScanResolution, code: string): ScanLookup {
  const scanned = normalizeScanCode(code);
  const base = { code: scanned, moreItems: 0, message: null } as const;

  if (resolution.kind === 'stock_item') {
    const item = resolution.stockItem;
    return {
      ...base,
      kind: 'stock_item',
      title: itemTitle(item),
      subtitle: [
        item.sku ? `SKU ${item.sku}` : null,
        item.locationCode ? `Ubicación ${item.locationCode}` : null,
        confidenceLabel(item.confidence),
      ]
        .filter(Boolean)
        .join(' · '),
      items: [toItem(item)],
      href: scanHref(scanned),
    };
  }

  if (resolution.kind === 'location') {
    const rows = resolution.stockItems;
    return {
      ...base,
      kind: 'location',
      title: `Ubicación ${resolution.location.code}`,
      subtitle: [resolution.location.label, countLabel(rows.length)].filter(Boolean).join(' · '),
      items: rows.slice(0, SCAN_MAX_ITEMS).map(toItem),
      moreItems: Math.max(0, rows.length - SCAN_MAX_ITEMS),
      href: scanHref(scanned),
    };
  }

  if (resolution.kind === 'sku') {
    const rows = resolution.stockItems;
    return {
      ...base,
      kind: 'sku',
      title: resolution.product.name ?? resolution.product.sku ?? resolution.product.zohoItemId,
      subtitle: [
        resolution.product.sku ? `SKU ${resolution.product.sku}` : null,
        countLabel(rows.length),
      ]
        .filter(Boolean)
        .join(' · '),
      items: rows.slice(0, SCAN_MAX_ITEMS).map(toItem),
      moreItems: Math.max(0, rows.length - SCAN_MAX_ITEMS),
      href: scanHref(scanned),
    };
  }

  return {
    ...base,
    kind: 'unknown',
    title: 'No reconocimos el código',
    subtitle: scanned ? `Leímos "${scanned}"` : 'No leímos nada',
    items: [],
    href: null,
    message: scanned
      ? 'No corresponde a una etiqueta, una ubicación ni un SKU de este almacén. Revisa el código o captúralo a mano.'
      : 'Escanea una etiqueta o escribe el código.',
  };
}

/**
 * Resolves a scanned code for the signed-in user. Throws `AuthorizationError`
 * when the person holds none of the inventory permissions (the route answers
 * 403 in Spanish).
 */
export async function lookupScan(
  actor: CurrentUser,
  code: string,
  options: { warehouseId?: string | null } = {}
): Promise<ScanLookup> {
  const scanned = normalizeScanCode(code);
  const resolution = await scanStockCode(actor, scanned, { warehouseId: options.warehouseId });
  return describeScan(resolution, scanned);
}
