import type { SourcingConfig, SourcingConfigPatch } from '@/modules/purchases/sourcing-config';

/**
 * Editor of the Sourcing Lab configuration (plan 6.1, `IntegrationConfig`
 * `source = 'sourcing'`). PURE and isomorphic: it runs in the browser, so it may
 * NOT import `sourcing-config.ts`'s runtime (that module loads Prisma) — only
 * its types.
 *
 * Nothing here decides business: the patch it builds is validated AGAIN by
 * `sourcingConfigPatchSchema` inside `updateSourcingConfig`, which is the single
 * source of truth for what a valid configuration is, and which also demands
 * `operations.admin` (the allowed hosts are an egress list and the connection
 * holds a credential).
 *
 * Why this screen exists: with the defaults (`allowedHosts: []`,
 * `rfqTemplateKey: null`, `braveConnectionId: null`, `rfqAccountId: null`) the
 * lab refuses every catalog page, the RFQ to a supplier without an open window
 * is blocked and the inbox account is whichever happens to be first. Before
 * this editor the only way to change them was editing the row by hand.
 */

export interface SourcingSettingsForm {
  isEnabled: boolean;
  /** One host per line (commas also accepted): `proveedor.com`, `*.proveedor.com`. */
  allowedHosts: string;
  braveConnectionId: string;
  dailyBudgetUnits: string;
  cacheTtlDays: string;
  maxPagesPerSearch: string;
  rfqDefaultDueDays: string;
  companyName: string;
  rfqAccountId: string;
  rfqTemplateKey: string;
  orderTemplateKey: string;
  rfqMessageTemplate: string;
  orderMessageTemplate: string;
}

export function toSourcingForm(config: SourcingConfig): SourcingSettingsForm {
  return {
    isEnabled: config.isEnabled,
    allowedHosts: config.allowedHosts.join('\n'),
    braveConnectionId: config.braveConnectionId ?? '',
    dailyBudgetUnits: String(config.dailyBudgetUnits),
    cacheTtlDays: String(config.cacheTtlDays),
    maxPagesPerSearch: String(config.maxPagesPerSearch),
    rfqDefaultDueDays: String(config.rfqDefaultDueDays),
    companyName: config.companyName,
    rfqAccountId: config.rfqAccountId ?? '',
    rfqTemplateKey: config.rfqTemplateKey ?? '',
    orderTemplateKey: config.orderTemplateKey ?? '',
    rfqMessageTemplate: config.rfqMessageTemplate,
    orderMessageTemplate: config.orderMessageTemplate,
  };
}

/** Same shape the server accepts (`*.dominio` or an exact host). */
const HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export interface HostListResult {
  ok: boolean;
  values: string[];
  /** Lines that are not a host (shown so the person can fix them). */
  invalid: string[];
}

/**
 * "proveedor.com\nhttps://*.otro.com/catalogo" → ['proveedor.com', '*.otro.com'].
 * The scheme and the path are dropped exactly as the server does, so what the
 * screen shows after saving is what the person wrote.
 */
export function parseAllowedHosts(raw: string): HostListResult {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const part of raw.split(/[\n,\s]+/)) {
    const line = part.trim();
    if (!line) continue;
    const host = line
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!HOST_PATTERN.test(host)) {
      if (!invalid.includes(line)) invalid.push(line);
      continue;
    }
    seen.add(host);
  }
  const values = [...seen];
  if (values.length > 200) {
    return { ok: false, values: values.slice(0, 200), invalid: ['más de 200 sitios'] };
  }
  return { ok: invalid.length === 0, values, invalid };
}

function parseIntField(
  raw: string,
  label: string,
  bounds: { min: number; max: number }
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return { ok: false, error: `${label}: escribe un entero entre ${bounds.min} y ${bounds.max}` };
  }
  return { ok: true, value };
}

function optionalId(raw: string): string | null {
  const value = raw.trim();
  return value ? value.slice(0, 120) : null;
}

export type SourcingPatchResult =
  { ok: true; patch: SourcingConfigPatch } | { ok: false; errors: string[] };

/** Bounds mirrored from `FIELDS` of `sourcing-config.ts` (the test compares them). */
export const SOURCING_BOUNDS = {
  dailyBudgetUnits: { min: 0, max: 100_000 },
  cacheTtlDays: { min: 1, max: 365 },
  maxPagesPerSearch: { min: 1, max: 5 },
  rfqDefaultDueDays: { min: 1, max: 60 },
} as const;

const TEMPLATE_MIN = 10;
const TEMPLATE_MAX = 2000;

export function sourcingFormToPatch(form: SourcingSettingsForm): SourcingPatchResult {
  const errors: string[] = [];

  const hosts = parseAllowedHosts(form.allowedHosts);
  if (!hosts.ok) {
    errors.push(
      `Sitios autorizados: «${hosts.invalid.slice(0, 3).join('», «')}» no es un dominio válido (usa proveedor.com o *.proveedor.com)`
    );
  }

  const numbers: Record<string, number> = {};
  for (const [field, label] of [
    ['dailyBudgetUnits', 'Presupuesto diario'],
    ['cacheTtlDays', 'Caché'],
    ['maxPagesPerSearch', 'Páginas por búsqueda'],
    ['rfqDefaultDueDays', 'Días para responder'],
  ] as const) {
    const parsed = parseIntField(form[field], label, SOURCING_BOUNDS[field]);
    if (parsed.ok) numbers[field] = parsed.value;
    else errors.push(parsed.error);
  }

  const companyName = form.companyName.trim();
  if (companyName.length < 1 || companyName.length > 120) {
    errors.push('Nombre de la empresa: escribe entre 1 y 120 caracteres');
  }

  for (const [field, label] of [
    ['rfqMessageTemplate', 'Texto de la cotización'],
    ['orderMessageTemplate', 'Texto de la orden'],
  ] as const) {
    const text = form[field].trim();
    if (text.length < TEMPLATE_MIN || text.length > TEMPLATE_MAX) {
      errors.push(`${label}: escribe entre ${TEMPLATE_MIN} y ${TEMPLATE_MAX} caracteres`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    patch: {
      isEnabled: form.isEnabled,
      allowedHosts: hosts.values,
      braveConnectionId: optionalId(form.braveConnectionId),
      dailyBudgetUnits: numbers.dailyBudgetUnits,
      cacheTtlDays: numbers.cacheTtlDays,
      maxPagesPerSearch: numbers.maxPagesPerSearch,
      rfqDefaultDueDays: numbers.rfqDefaultDueDays,
      companyName,
      rfqAccountId: optionalId(form.rfqAccountId),
      rfqTemplateKey: optionalId(form.rfqTemplateKey),
      orderTemplateKey: optionalId(form.orderTemplateKey),
      rfqMessageTemplate: form.rfqMessageTemplate.trim(),
      orderMessageTemplate: form.orderMessageTemplate.trim(),
    },
  };
}

/**
 * What stops working with the configuration as it stands, in Spanish. Shown
 * above the form so nobody has to read the code to learn why the lab answers
 * "ninguna página está en los sitios autorizados".
 */
export function sourcingConfigWarnings(config: SourcingConfig): string[] {
  const out: string[] = [];
  if (!config.isEnabled) {
    out.push('El laboratorio está apagado: no se ejecuta ninguna búsqueda.');
  }
  if (config.allowedHosts.length === 0) {
    out.push(
      'Sin sitios autorizados: el laboratorio rechaza cualquier página de catálogo antes de salir a internet.'
    );
  }
  if (!config.rfqTemplateKey) {
    out.push(
      'Sin plantilla aprobada de cotización: sólo se puede escribir por WhatsApp a un proveedor con ventana de 24 h abierta.'
    );
  }
  if (!config.orderTemplateKey) {
    out.push(
      'Sin plantilla aprobada de orden: enviar la orden por WhatsApp a un proveedor sin ventana abierta queda bloqueado.'
    );
  }
  if (!config.braveConnectionId) {
    out.push(
      'Sin conexión de Brave Search: si no hay una herramienta MCP de búsqueda conectada, la búsqueda web no tiene respaldo.'
    );
  }
  if (!config.rfqAccountId) {
    out.push(
      'Sin cuenta de bandeja elegida: los mensajes a proveedores salen por la primera cuenta activa del canal.'
    );
  }
  return out;
}
