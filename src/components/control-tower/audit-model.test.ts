import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  AUDIT_ADMIN_TARGET_TYPES,
  AUDIT_CORE_TARGET_TYPES,
  AUDIT_DOMAIN_TARGET_TYPES,
  AUDIT_TARGET_GROUPS,
  AUDIT_TARGET_TYPES,
  EMPTY_AUDIT_FILTERS,
  auditFiltersFromParams,
  auditQueryString,
  auditTargetLabel,
  hasAuditFilters,
  humanizeAuditAction,
  summarizeAuditMetadata,
} from './audit-model';
import { CASE_ROW_ACTIONS, OPPORTUNITY_ROW_ACTIONS } from '@/modules/areas/ventas/row-actions';
import {
  GOODS_RECEIPT_ROW_ACTIONS,
  ORDER_ROW_ACTIONS as COMPRAS_ORDER_ROW_ACTIONS,
  PURCHASE_REQUEST_ROW_ACTIONS,
  RFQ_ROW_ACTIONS,
} from '@/modules/areas/compras/row-actions';
import {
  OPERATION_ROW_ACTIONS,
  ORDER_ROW_ACTIONS as MANUFACTURA_ORDER_ROW_ACTIONS,
} from '@/modules/areas/manufactura/row-actions';
import {
  EXPENSE_ROW_ACTIONS,
  OBLIGATION_AUTHORIZATION_ACTIONS,
  OBLIGATION_CANCEL_ACTIONS,
} from '@/modules/areas/contabilidad/contabilidad-model';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..', '..');

describe('audit-model', () => {
  it('traduce cada tipo de objeto que ofrece el filtro', () => {
    for (const type of AUDIT_TARGET_TYPES) {
      expect(auditTargetLabel(type)).not.toBe(type);
    }
    // Un tipo nuevo del servidor se muestra tal cual en vez de desaparecer.
    expect(auditTargetLabel('tipo_nuevo')).toBe('tipo_nuevo');
  });

  it('el vocabulario es UNO solo, sin repetidos, y los grupos lo cubren entero', () => {
    // El hueco de §7.7: había dos listas (la del selector y la de la ruta) y ya
    // divergían en `integration_config`, así que elegir esa opción no filtraba:
    // la ruta la descartaba y devolvía todo lo demás.
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);
    expect(AUDIT_TARGET_GROUPS.flatMap((group) => group.types).sort()).toStrictEqual(
      [...AUDIT_TARGET_TYPES].sort()
    );
    expect(AUDIT_TARGET_TYPES).toContain('integration_config');
    for (const group of AUDIT_TARGET_GROUPS) expect(group.types.length).toBeGreaterThan(0);
  });

  it('la ruta de la API no tiene una lista propia', () => {
    const route = readFileSync(
      path.join(srcRoot, 'app/app/admin/control-tower/api/audit/route.ts'),
      'utf8'
    );
    expect(route).toContain("from '@/components/control-tower/audit-model'");
    // Nada de volver a declarar los tipos a mano en la ruta.
    expect(route).not.toMatch(/OPERATIONS_TARGET_TYPES = \[/);
  });

  it('cada acción de fila de las áreas escribe un objeto que la auditoría sabe mostrar', () => {
    // `executeCommand` audita con `targetType: cmd.aggregate.type`. Si un
    // agregado no está en el vocabulario, mandar esa orden de compra o aprobar
    // ese gasto NO se puede leer desde ninguna pantalla: la Torre es la única
    // que consulta `AuditLog` de operaciones.
    const catalogs = [
      ...OPPORTUNITY_ROW_ACTIONS,
      ...CASE_ROW_ACTIONS,
      ...PURCHASE_REQUEST_ROW_ACTIONS,
      ...RFQ_ROW_ACTIONS,
      ...COMPRAS_ORDER_ROW_ACTIONS,
      ...GOODS_RECEIPT_ROW_ACTIONS,
      ...MANUFACTURA_ORDER_ROW_ACTIONS,
      ...OPERATION_ROW_ACTIONS,
      ...Object.values(EXPENSE_ROW_ACTIONS).flat(),
      ...OBLIGATION_CANCEL_ACTIONS,
      ...OBLIGATION_AUTHORIZATION_ACTIONS,
    ];
    expect(catalogs.length).toBeGreaterThan(20);
    const missing = [
      ...new Set(
        catalogs
          .map((action) => action.aggregateType)
          .filter((type) => !(AUDIT_TARGET_TYPES as readonly string[]).includes(type))
      ),
    ].sort();
    expect(missing).toStrictEqual([]);
  });

  it('cubre también los agregados que las ramas SQL escriben a mano', () => {
    // Inventario y Logística arman sus acciones dentro del SQL, así que no hay
    // catálogo que importar: se fijan aquí con el archivo que los declara.
    for (const type of [
      'stock_count',
      'stock_reservation',
      'trip',
      'delivery_order',
      'expense',
      'obligation',
    ]) {
      expect(AUDIT_TARGET_TYPES).toContain(type);
    }
  });

  it('ninguna opción del selector es un fantasma que nadie escribe', () => {
    // `operations_config` estuvo en la lista sin que nadie lo escribiera nunca
    // (la bandera de operaciones se audita como `integration_config`), así que
    // esa opción siempre devolvía cero filas sin decir por qué.
    const hidden = new Set(['operations_config', 'operational_command', 'process_version']);
    for (const type of AUDIT_TARGET_TYPES) expect(hidden.has(type)).toBe(false);
  });

  it('los grupos no se pisan entre sí', () => {
    const core = new Set<string>(AUDIT_CORE_TARGET_TYPES);
    const domain = new Set<string>(AUDIT_DOMAIN_TARGET_TYPES);
    for (const type of AUDIT_ADMIN_TARGET_TYPES) {
      expect(core.has(type)).toBe(false);
      expect(domain.has(type)).toBe(false);
    }
    for (const type of AUDIT_DOMAIN_TARGET_TYPES) expect(core.has(type)).toBe(false);
  });

  it('las exportaciones escriben el objeto en el mismo vocabulario', () => {
    // Escritas como `'OperationalCase'` y `'Area'` esas filas se guardaban y no
    // se podían leer: el filtro es exacto (`targetType: { in: [...] }`).
    const cases = readFileSync(path.join(srcRoot, 'app/app/operations/actions.ts'), 'utf8');
    expect(cases).toContain("targetType: 'operational_case'");
    expect(cases).not.toContain("targetType: 'OperationalCase'");
    const areas = readFileSync(path.join(srcRoot, 'app/app/areas/[areaKey]/actions.ts'), 'utf8');
    expect(areas).toContain("targetType: 'area'");
    expect(areas).not.toContain("targetType: 'Area'");
    expect(AUDIT_TARGET_TYPES).toContain('operational_case');
    expect(AUDIT_TARGET_TYPES).toContain('area');
  });

  it('hace legible una acción sin inventar traducciones', () => {
    expect(humanizeAuditAction('workitem.reassigned')).toBe('Workitem · reassigned');
    expect(humanizeAuditAction('operations.approval_policy.created')).toBe(
      'Operations · approval policy created'
    );
    expect(humanizeAuditAction('algo')).toBe('Algo');
  });

  it('lee los filtros de la URL en español', () => {
    expect(
      auditFiltersFromParams({ accion: 'workitem', objeto: 'work_item', desde: '2026-09-01' })
    ).toEqual({
      action: 'workitem',
      targetType: 'work_item',
      targetId: '',
      actorUserId: '',
      from: '2026-09-01',
      to: '',
    });
    expect(auditFiltersFromParams({})).toEqual(EMPTY_AUDIT_FILTERS);
  });

  it('arma la consulta sin mandar filtros vacíos', () => {
    const query = auditQueryString(
      { ...EMPTY_AUDIT_FILTERS, action: '  workitem  ', targetType: 'work_item' },
      2,
      50
    );
    const params = new URLSearchParams(query);
    expect(params.get('action')).toBe('workitem');
    expect(params.get('targetType')).toBe('work_item');
    expect(params.get('page')).toBe('2');
    expect(params.get('page_size')).toBe('50');
    expect(params.has('targetId')).toBe(false);
  });

  it('nunca pide una página menor que 1', () => {
    const params = new URLSearchParams(auditQueryString(EMPTY_AUDIT_FILTERS, 0, 50));
    expect(params.get('page')).toBe('1');
  });

  it('sabe si hay filtros aplicados', () => {
    expect(hasAuditFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
    expect(hasAuditFilters({ ...EMPTY_AUDIT_FILTERS, targetId: 'abc' })).toBe(true);
  });

  it('resume la metadata sin volcar el JSON crudo', () => {
    expect(summarizeAuditMetadata({ scope: 'expense', requiredApprovals: 2 })).toBe(
      'scope: expense · requiredApprovals: 2'
    );
    expect(summarizeAuditMetadata({ roles: ['a', 'b'] })).toBe('roles: a, b');
    expect(summarizeAuditMetadata({ nested: { a: 1 } })).toBe('nested: …');
    expect(summarizeAuditMetadata({ vacio: '', nulo: null })).toBeNull();
    expect(summarizeAuditMetadata(null)).toBeNull();
    expect(summarizeAuditMetadata(['a'])).toBeNull();
  });

  it('corta un resumen larguísimo', () => {
    const summary = summarizeAuditMetadata({ campo: 'x'.repeat(200) }, 40);
    expect(summary).toBeTruthy();
    expect((summary ?? '').length).toBeLessThanOrEqual(40);
    expect(summary?.endsWith('…')).toBe(true);
  });
});
