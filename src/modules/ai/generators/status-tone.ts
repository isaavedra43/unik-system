/**
 * Shared status→color mapping for every report format (PDF, Excel, report image).
 *
 * Single source of truth so a status never renders in a different color depending on
 * which artifact generated it. Tones mirror `SalesOrderStatusConfig.tone` from
 * `@/modules/sales/sales-orders-helpers` (success/info/warning/danger/muted) — the same
 * semantic buckets the app's own status dots use — just re-expressed as hex colors for
 * generators that don't have access to that module's CSS classes.
 */

export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'muted';

export const TONE_HEX: Record<StatusTone, string> = {
  success: '#15803d',
  info: '#2563eb',
  warning: '#b45309',
  danger: '#b91c1c',
  muted: '#64748b',
};

/** Light tint of each tone, for badge/pill backgrounds. */
export const TONE_TINT_HEX: Record<StatusTone, string> = {
  success: '#dcfce7',
  info: '#dbeafe',
  warning: '#fef3c7',
  danger: '#fee2e2',
  muted: '#f1f5f9',
};

const STATUS_LABEL_TONES: Record<string, StatusTone> = {
  // order / ticket status
  confirmada: 'info', confirmado: 'info', cerrada: 'success', cerrado: 'success',
  anulada: 'danger', anulado: 'danger', cancelada: 'danger', cancelado: 'danger',
  borrador: 'warning', abierta: 'info', abierto: 'info', 'en espera': 'warning',
  aprobada: 'success', 'pendiente de aprobación': 'warning',
  'en tránsito': 'info', 'pendiente de envío': 'warning', 'pago pendiente': 'warning',
  'sin facturar': 'muted', entregado: 'success', entregada: 'success',
  // payment
  pagada: 'success', pagado: 'success', parcial: 'warning', pendiente: 'warning',
  vencida: 'danger', 'sin pagar': 'warning',
  // invoicing
  facturada: 'success', 'no facturada': 'muted',
  // shipping
  enviado: 'info', 'no enviado': 'warning', empaquetado: 'info', cumplido: 'success',
  // packages / other domains
  entregando: 'info', 'en camino': 'info', exitoso: 'success', fallido: 'danger',
  reembolsado: 'muted', vista: 'info', enviada: 'info', emitida: 'info', recibida: 'success',
};

/** The semantic tone for a known Spanish status label, or null if the text isn't a status word. */
export function toneForStatusLabel(value: string): StatusTone | null {
  return STATUS_LABEL_TONES[value.trim().toLowerCase()] ?? null;
}

/** Hex color for a known Spanish status label, or null if the text isn't a status word. */
export function colorForStatusLabel(value: string): string | null {
  const tone = toneForStatusLabel(value);
  return tone ? TONE_HEX[tone] : null;
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$|^#(?:[0-9a-fA-F]{4}){1,2}$/;

/**
 * Validates a color string is a plain hex color (#rgb / #rrggbb / #rrggbbaa) before it's
 * interpolated into an SVG `fill`/`stroke` attribute. Color values in these reports come from
 * AI tool-call arguments (model-controlled, ultimately conversation-influenced) — without this,
 * a value like `red" onload="alert(1)` would break out of the attribute when the generated SVG
 * is rendered via `dangerouslySetInnerHTML` in the chat UI. Falls back to `fallback` for
 * anything that isn't a strict hex color (this intentionally rejects CSS named colors too,
 * since the attack surface isn't worth supporting them here).
 */
export function sanitizeSvgColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  return HEX_COLOR_RE.test(v) ? v : fallback;
}

const DEFAULT_ARGB = 'FF2563EB';

/**
 * Converts a `#rrggbb` CSS hex color to ExcelJS's `FFrrggbb` ARGB format. Only accepts the
 * 6-digit form (matching every color this codebase actually produces/documents); anything
 * else falls back to the default brand ARGB rather than emitting a malformed ARGB string.
 */
export function hexToArgb(hex: string): string {
  const stripped = hex.replace('#', '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(stripped) ? `FF${stripped}` : DEFAULT_ARGB;
}
