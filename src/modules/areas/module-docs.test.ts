import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INVENTORY_COMMANDS } from '@/modules/inventory/inventory-commands';
import { INVENTORY_ERROR_HTTP_STATUS, INVENTORY_EVENTS } from '@/modules/inventory/inventory-types';
import { INVENTORY_PERMISSIONS } from '@/modules/inventory/permissions';
import { LOGISTICS_ERROR_HTTP_STATUS } from '@/modules/logistics/logistics-helpers';
import { LOGISTICS_PERMISSIONS } from '@/modules/logistics/permissions';
import {
  LOGISTICS_COMMANDS,
  LOGISTICS_EVENTS,
  LOGISTICS_JOB_TYPES,
} from '@/modules/logistics/types';
import { LOGISTICS_TOOL_NAMES } from '@/modules/ai/tools/logistics-tools';

/**
 * `docs/modules/<módulo>.md` es la puerta de cada entrega del plan (§8) y la
 * referencia de quien retome el módulo. Se quedó atrás: durante meses
 * `inventory.md` dijo «Falta la UI del área Inventario» y `logistics.md` dijo
 * «la PWA del chofer … todavía no existe» mientras las dos áreas ya estaban
 * construidas, registradas y navegables. Un documento que miente es peor que no
 * tenerlo: manda a reimplementar lo que ya existe.
 *
 * Esta prueba es la red que faltaba. NO juzga la prosa: ata el documento al
 * código, en los dos sentidos.
 *
 * - Todo lo que el código declara —comandos, códigos de error, permisos,
 *   eventos, jobs y tools— tiene que estar nombrado en el documento. Añadir un
 *   comando sin documentarlo falla aquí y no en el piloto.
 * - Toda pantalla que existe tiene que estar nombrada, y todo archivo que el
 *   documento cita entre comillas invertidas tiene que existir: así el
 *   documento no puede declarar «falta» algo entregado ni apuntar a un archivo
 *   borrado.
 * - Las frases exactas que estaban obsoletas quedan prohibidas, para que no
 *   vuelvan de un copiar y pegar.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function readDoc(relative: string): string {
  const full = path.join(repoRoot, relative);
  expect(existsSync(full), `${relative} debe existir`).toBe(true);
  return readFileSync(full, 'utf8');
}

/**
 * Los documentos comprimen familias de eventos (`stock.count_started|closed`),
 * que es como se leen bien. Esta función devuelve cada nombre que el documento
 * declara, expandiendo esas listas: para `a.b_c|d|e_f` valen `a.b_c`, `a.d`,
 * `a.b_d`, `a.e_f`… es decir, el prefijo del primer elemento cortado en cada
 * `.` o `_` más cada alternativa.
 */
function declaredTokens(doc: string): Set<string> {
  const tokens = new Set<string>();
  for (const [, span] of doc.matchAll(/`([^`]+)`/g)) {
    for (const raw of span.split(/[\s,;()[\]{}]+/)) {
      const token = raw.replace(/^[.:]+|[.:,]+$/g, '');
      if (!token) continue;
      tokens.add(token);
      if (!token.includes('|')) continue;
      const parts = token.split('|');
      const first = parts[0];
      tokens.add(first);
      const prefixes: string[] = [];
      for (let i = 0; i < first.length; i += 1) {
        if (first[i] === '.' || first[i] === '_') prefixes.push(first.slice(0, i + 1));
      }
      for (const part of parts.slice(1)) {
        if (!part) continue;
        tokens.add(part);
        for (const prefix of prefixes) tokens.add(prefix + part);
      }
    }
  }
  return tokens;
}

/** La llave como palabra completa: `trip.close` no lo satisface `trip.closed`. */
function mentions(doc: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_.])`).test(doc);
}

/** Rutas del repositorio citadas entre comillas invertidas. */
function citedPaths(doc: string): string[] {
  const found = new Set<string>();
  for (const [, span] of doc.matchAll(/`([^`]+)`/g)) {
    for (const raw of span.split(/[\s,;()[\]{}]+/)) {
      const candidate = raw.replace(/[.,;:]+$/g, '');
      if (!/^(src|docs|prisma|public|scripts|tests|e2e)\//.test(candidate)) continue;
      // `src/modules/inventory/*.test.ts` y compañía son patrones, no archivos.
      if (candidate.includes('*')) continue;
      found.add(candidate);
    }
  }
  return [...found];
}

interface ModuleDoc {
  /** Nombre humano del módulo, para los mensajes de fallo. */
  label: string;
  file: string;
  commands: readonly string[];
  errorCodes: readonly string[];
  permissions: readonly string[];
  events: readonly string[];
  jobs: readonly string[];
  tools: readonly string[];
  /**
   * Pantallas entregadas: el archivo tiene que existir Y el documento tiene que
   * nombrarlo. Si alguien borra la pantalla, el documento deja de ser verdad
   * por el otro lado y la prueba también falla.
   */
  surfaces: readonly { file: string; mention: string }[];
  /** Frases que ya fueron falsas: no pueden volver. */
  forbidden: readonly string[];
}

const INVENTORY_DOC: ModuleDoc = {
  label: 'Inventario',
  file: 'docs/modules/inventory.md',
  commands: Object.values(INVENTORY_COMMANDS),
  errorCodes: Object.keys(INVENTORY_ERROR_HTTP_STATUS),
  permissions: INVENTORY_PERMISSIONS.map((permission) => permission.key),
  events: Object.values(INVENTORY_EVENTS),
  jobs: [],
  tools: [],
  surfaces: [
    { file: 'src/modules/areas/inventario/register.ts', mention: 'src/modules/areas/inventario/' },
    { file: 'src/modules/areas/inventario/dashboard.ts', mention: 'dashboard.ts' },
    {
      file: 'src/modules/areas/inventario/inventory-area-queries.ts',
      mention: 'inventory-area-queries.ts',
    },
    { file: 'src/components/areas/inventario/register-client.tsx', mention: 'register-client.tsx' },
    { file: 'src/components/areas/inventario/LocationsMap.tsx', mention: 'LocationsMap' },
    { file: 'src/components/areas/inventario/CountCapture.tsx', mention: 'CountCapture' },
    { file: 'src/components/areas/inventario/LocationDrawer.tsx', mention: 'LocationDrawer' },
    { file: 'src/components/areas/inventario/StockTable.tsx', mention: 'StockTable' },
    {
      file: 'src/components/areas/inventario/StockActionsDialog.tsx',
      mention: 'StockActionsDialog',
    },
    { file: 'src/components/areas/inventario/LocationsAdmin.tsx', mention: 'LocationsAdmin' },
    { file: 'src/components/areas/inventario/LabelSheet.tsx', mention: 'LabelSheet' },
    { file: 'src/components/areas/inventario/ProfileForm.tsx', mention: 'ProfileForm' },
    {
      file: 'src/components/areas/inventario/CountDecisionsPanel.tsx',
      mention: 'CountDecisionsPanel',
    },
    { file: 'src/components/areas/inventario/LegacyClaimPanel.tsx', mention: 'LegacyClaimPanel' },
    { file: 'src/components/areas/inventario/qr-code.ts', mention: 'qr-code.ts' },
    {
      file: 'src/app/app/areas/inventario/existencias/page.tsx',
      mention: '/app/areas/inventario/existencias',
    },
    {
      file: 'src/app/app/areas/inventario/ubicaciones/page.tsx',
      mention: '/app/areas/inventario/ubicaciones',
    },
    {
      file: 'src/app/app/areas/inventario/perfiles/[zohoItemId]/page.tsx',
      mention: '/app/areas/inventario/perfiles/',
    },
    {
      file: 'src/app/app/areas/[areaKey]/api/inventario/map/route.ts',
      mention: 'api/inventario/',
    },
  ],
  forbidden: [
    'Falta la UI del área Inventario',
    '`assignedToProduction` está en la fórmula pero nadie lo escribe',
  ],
};

const LOGISTICS_DOC: ModuleDoc = {
  label: 'Logística',
  file: 'docs/modules/logistics.md',
  commands: Object.values(LOGISTICS_COMMANDS),
  errorCodes: Object.keys(LOGISTICS_ERROR_HTTP_STATUS),
  permissions: LOGISTICS_PERMISSIONS.map((permission) => permission.key),
  events: Object.values(LOGISTICS_EVENTS).flatMap((group) => Object.values(group)),
  jobs: Object.values(LOGISTICS_JOB_TYPES),
  tools: LOGISTICS_TOOL_NAMES,
  surfaces: [
    { file: 'src/modules/areas/logistica/register.ts', mention: 'src/modules/areas/logistica/' },
    {
      file: 'src/modules/areas/logistica/logistics-view-model.ts',
      mention: 'logistics-view-model.ts',
    },
    { file: 'src/components/areas/logistica/register-client.tsx', mention: 'register-client.tsx' },
    { file: 'src/components/areas/logistica/DispatchBoard.tsx', mention: 'DispatchBoard' },
    { file: 'src/components/areas/logistica/DispatchMap.tsx', mention: 'DispatchMap' },
    { file: 'src/components/areas/logistica/DeliveryCard.tsx', mention: 'DeliveryCard' },
    { file: 'src/components/areas/logistica/VehicleTimeline.tsx', mention: 'VehicleTimeline' },
    {
      file: 'src/components/areas/logistica/AssignTransportDialog.tsx',
      mention: 'AssignTransportDialog',
    },
    { file: 'src/components/areas/logistica/BuildTripDialog.tsx', mention: 'BuildTripDialog' },
    { file: 'src/components/areas/logistica/TripDetailView.tsx', mention: 'TripDetailView' },
    { file: 'src/components/areas/logistica/TripStopsEditor.tsx', mention: 'TripStopsEditor' },
    { file: 'src/components/areas/logistica/FleetManager.tsx', mention: 'FleetManager' },
    { file: 'src/components/areas/logistica/ZohoSyncPill.tsx', mention: 'ZohoSyncPill' },
    { file: 'src/components/areas/logistica/DriverApp.tsx', mention: 'DriverApp' },
    {
      file: 'src/app/app/areas/[areaKey]/chofer/page.tsx',
      mention: '/app/areas/logistica/chofer',
    },
    {
      file: 'src/app/app/areas/[areaKey]/chofer/api/today/route.ts',
      mention: '/app/areas/logistica/chofer/api/today',
    },
    {
      file: 'src/app/app/areas/[areaKey]/chofer/api/commands/route.ts',
      mention: '/app/areas/logistica/chofer/api/commands',
    },
    { file: 'src/app/app/areas/[areaKey]/flota/page.tsx', mention: '/app/areas/logistica/flota' },
    {
      file: 'src/app/app/areas/[areaKey]/viajes/[id]/page.tsx',
      mention: '/app/areas/logistica/viajes',
    },
    {
      file: 'src/app/app/areas/[areaKey]/api/logistica/despacho/route.ts',
      mention: 'api/logistica/',
    },
    { file: 'src/modules/ai/tools/logistics-tools.ts', mention: 'logistics-tools.ts' },
  ],
  forbidden: [
    'La UI de despacho, el mapa y la PWA del chofer son de la entrega 4 y',
    'Faltan la UI de despacho',
    'ni categoría de notificación `delivery_update`',
  ],
};

describe.each([INVENTORY_DOC, LOGISTICS_DOC])('$file describe el módulo real', (module) => {
  const doc = readDoc(module.file);
  const tokens = declaredTokens(doc);

  // Una prueba que no compara nada pasa siempre: esto obliga a que las listas
  // vengan del código y no de un import que quedó vacío.
  it('compara contra listas reales, no vacías', () => {
    expect(module.commands.length).toBeGreaterThan(9);
    expect(module.errorCodes.length).toBeGreaterThan(9);
    expect(module.permissions.length).toBeGreaterThan(3);
    expect(module.events.length).toBeGreaterThan(9);
    expect(module.surfaces.length).toBeGreaterThan(9);
    expect(citedPaths(doc).length).toBeGreaterThan(4);
    expect(tokens.size).toBeGreaterThan(50);
  });

  it('nombra todos los comandos registrados', () => {
    const missing = module.commands.filter((type) => !tokens.has(type));
    expect(missing, `${module.label}: comandos sin documentar`).toEqual([]);
  });

  it('nombra todos los códigos de error del módulo', () => {
    const missing = module.errorCodes.filter((code) => !mentions(doc, code));
    expect(missing, `${module.label}: códigos de error sin documentar`).toEqual([]);
  });

  it('nombra todos los permisos del módulo', () => {
    const missing = module.permissions.filter((key) => !mentions(doc, key));
    expect(missing, `${module.label}: permisos sin documentar`).toEqual([]);
  });

  it('nombra todos los eventos que emite', () => {
    const missing = module.events.filter((event) => !tokens.has(event));
    expect(missing, `${module.label}: eventos sin documentar`).toEqual([]);
  });

  it('nombra todos los jobs y todas las tools de IA del módulo', () => {
    const missingJobs = module.jobs.filter((job) => !tokens.has(job));
    const missingTools = module.tools.filter((tool) => !mentions(doc, tool));
    expect(missingJobs, `${module.label}: jobs sin documentar`).toEqual([]);
    expect(missingTools, `${module.label}: tools sin documentar`).toEqual([]);
  });

  it('describe las pantallas que existen (y sólo las que existen)', () => {
    const missingFiles = module.surfaces
      .map((surface) => surface.file)
      .filter((file) => !existsSync(path.join(repoRoot, file)));
    expect(
      missingFiles,
      `${module.label}: el documento describe archivos que ya no existen`
    ).toEqual([]);

    const undocumented = module.surfaces
      .filter((surface) => !doc.includes(surface.mention))
      .map((surface) => `${surface.file} (falta «${surface.mention}»)`);
    expect(undocumented, `${module.label}: pantallas entregadas sin documentar`).toEqual([]);
  });

  it('no cita archivos inexistentes', () => {
    const broken = citedPaths(doc).filter((cited) => !existsSync(path.join(repoRoot, cited)));
    expect(broken, `${module.label}: rutas citadas que no existen`).toEqual([]);
  });

  it('no repite las afirmaciones que ya fueron falsas', () => {
    const revived = module.forbidden.filter((phrase) => doc.includes(phrase));
    expect(revived, `${module.label}: frases obsoletas de vuelta en el documento`).toEqual([]);
  });
});
