import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PermissionDefinition } from './permissions';
import { OPERATIONS_PERMISSIONS } from '@/modules/operations/permissions';
import { INVENTORY_PERMISSIONS } from '@/modules/inventory/permissions';
import { LOGISTICS_PERMISSIONS } from '@/modules/logistics/permissions';
import { PURCHASES_PERMISSIONS } from '@/modules/purchases/permissions';
import { CRM_PERMISSIONS } from '@/modules/crm/permissions';
import { MANUFACTURING_PERMISSIONS } from '@/modules/manufacturing/permissions';
import { FINANCE_PERMISSIONS } from '@/modules/finance/permissions';

/**
 * A permission key that nobody assigns is a module nobody can use: the areas of
 * the Operations program are invisible in production until Israel gives their
 * keys to a role, and the only place that list lives is `docs/pilot-runbook.md`
 * §11 (plan 12: "las verificaciones PENDIENTE PRODUCCIÓN de cada entrega se
 * acumulan en docs/pilot-runbook.md").
 *
 * So this test reads the runbook as data and demands that every key of the
 * seven program modules is named there, inside §11 and inside a section that
 * actually carries a PENDIENTE PRODUCCIÓN checklist. Adding a permission
 * without documenting how to hand it out now fails here instead of in the
 * pilot.
 *
 * It does NOT check the prose: it checks the contract between the code-first
 * registry and the activation checklist.
 */

const RUNBOOK_PATH = new URL('../../../docs/pilot-runbook.md', import.meta.url);
const runbook = readFileSync(RUNBOOK_PATH, 'utf8');

/** Body of `## 11` (its sections) — the activation checklist of the program. */
function operationsChapter(text: string): string {
  const start = text.indexOf('\n## 11. Operaciones');
  expect(start, 'el runbook debe tener el capítulo «## 11. Operaciones»').toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

const chapter = operationsChapter(runbook);

/** `### 11.x Título` → body, in file order. */
function sectionsOf(text: string): { heading: string; body: string }[] {
  const lines = text.split('\n');
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n') });
      current = { heading: line.slice(4).trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n') });
  return sections;
}

const sections = sectionsOf(chapter);

/**
 * The key as a whole word: `crm.manage` must not be satisfied by
 * `crm.manage_stages`, and `inventory.count` not by `inventory.counts`.
 */
function mentions(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9_.])`).test(text);
}

const MODULES: { area: string; permissions: PermissionDefinition[] }[] = [
  { area: 'Operaciones', permissions: OPERATIONS_PERMISSIONS },
  { area: 'Inventario', permissions: INVENTORY_PERMISSIONS },
  { area: 'Logística', permissions: LOGISTICS_PERMISSIONS },
  { area: 'Compras', permissions: PURCHASES_PERMISSIONS },
  { area: 'Ventas / CRM', permissions: CRM_PERMISSIONS },
  { area: 'Manufactura', permissions: MANUFACTURING_PERMISSIONS },
  { area: 'Contabilidad', permissions: FINANCE_PERMISSIONS },
];

describe('docs/pilot-runbook.md §11 — permisos del programa de Operaciones', () => {
  it('nombra las 42 llaves de las siete áreas', () => {
    const keys = MODULES.flatMap((m) => m.permissions.map((p) => p.key));
    expect(keys).toHaveLength(42);
    expect(new Set(keys).size).toBe(keys.length);
    const missing = keys.filter((key) => !mentions(chapter, key));
    expect(
      missing,
      `Estas llaves no aparecen en §11 del runbook, así que nadie sabe a qué rol asignarlas: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it.each(MODULES)(
    '$area: cada llave vive en una sección con checklist PENDIENTE PRODUCCIÓN',
    ({ permissions }) => {
      for (const permission of permissions) {
        const hosting = sections.filter(
          (section) =>
            mentions(section.body, permission.key) && section.body.includes('PENDIENTE PRODUCCIÓN')
        );
        expect(
          hosting.length,
          `«${permission.key}» (${permission.label}) no está en ninguna sección de §11 con checklist PENDIENTE PRODUCCIÓN`
        ).toBeGreaterThan(0);
      }
    }
  );

  it('las cuatro áreas de dominio tienen su sección propia con permisos y pendientes', () => {
    const expected = [
      { title: 'Compras y Sourcing', keys: PURCHASES_PERMISSIONS },
      { title: 'CRM y Radar', keys: CRM_PERMISSIONS },
      { title: 'Manufactura', keys: MANUFACTURING_PERMISSIONS },
      { title: 'Contabilidad interna', keys: FINANCE_PERMISSIONS },
    ];
    for (const area of expected) {
      const section = sections.find((s) => s.heading.includes(area.title));
      expect(section, `falta la sección de §11 de «${area.title}»`).toBeDefined();
      const body = section!.body;
      expect(body, `«${area.title}» sin checklist`).toContain('PENDIENTE PRODUCCIÓN');
      expect(body.includes('- [ ]'), `«${area.title}» sin casillas por marcar`).toBe(true);
      for (const permission of area.keys) {
        expect(
          mentions(body, permission.key),
          `«${area.title}» no menciona ${permission.key}`
        ).toBe(true);
      }
    }
  });

  it('ninguna entrega del plan aparece con dos secciones distintas', () => {
    const labels = sections
      .map((section) => /^\d+\.\d+ (Entrega \d+) —/.exec(section.heading)?.[1])
      .filter((label): label is string => Boolean(label));
    expect(
      new Set(labels).size,
      `entregas repetidas en los encabezados: ${labels.join(', ')}`
    ).toBe(labels.length);
  });
});
