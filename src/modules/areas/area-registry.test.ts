import { describe, expect, it } from 'vitest';
import { isKnownPermission } from '@/modules/auth/permissions';
import { AREA_KEYS } from '@/modules/operations/types';
import {
  AREA_LIST,
  AREA_REGISTRY,
  AREA_SPACE_SLUGS,
  AREA_WORKSPACE_KEYS,
  COMMON_ROW_KINDS,
  areaActPermissions,
  areaApprovePermissions,
  areaDetailHref,
  areaEntryPermissions,
  areaExportPermissions,
  areaHref,
  areaSpaces,
  areaViewPermissions,
  findAreaSpace,
  findAreaSubpage,
  flushAreaRoutes,
  getArea,
  holdsAny,
  isAreaWorkspaceKey,
  knownAreaPermissions,
  rowKindsForSpace,
  visibleAreaSpaces,
} from './area-registry';

const user = (permissionKeys: string[], isSuperAdmin = false) => ({ permissionKeys, isSuperAdmin });

describe('registro de áreas', () => {
  it('cubre las seis áreas operativas; Administración vive en la Torre de Control', () => {
    expect([...AREA_WORKSPACE_KEYS]).toStrictEqual([
      'ventas',
      'compras',
      'inventario',
      'manufactura',
      'logistica',
      'contabilidad',
    ]);
    expect(AREA_WORKSPACE_KEYS.every((key) => (AREA_KEYS as readonly string[]).includes(key))).toBe(
      true
    );
    expect(getArea('administracion')).toBeNull();
  });

  it('un área desconocida no existe (la ruta responde 404)', () => {
    expect(getArea('marketing')).toBeNull();
    expect(getArea('')).toBeNull();
    expect(getArea(null)).toBeNull();
    expect(getArea(undefined)).toBeNull();
    expect(isAreaWorkspaceKey('ventas')).toBe(true);
    expect(isAreaWorkspaceKey('administracion')).toBe(false);
  });

  it('usa permisos reales de cada módulo, nunca familias inventadas', () => {
    for (const area of AREA_LIST) {
      const declared = [
        ...area.permissions.view,
        ...area.permissions.act,
        ...area.permissions.approve,
        ...(area.permissions.export ?? []),
        ...area.subpages.map((subpage) => subpage.permission),
      ];
      expect(declared.length).toBeGreaterThan(0);
      for (const key of declared) {
        expect(isKnownPermission(key), `${area.key}: ${key}`).toBe(true);
        expect(key.startsWith('area.')).toBe(false);
        expect(/^operations\.[a-z]+\.(act|approve)$/.test(key)).toBe(false);
      }
    }
  });

  it('cada área tiene su tabla, su canal y una vista especial propia', () => {
    const tableKeys = new Set<string>();
    const channels = new Set<string>();
    for (const area of AREA_LIST) {
      expect(area.workCenter.tableKey).toBe(`areas:${area.key}:work`);
      expect(area.comms.channelKey).toBe(`area:${area.key}`);
      expect(area.comms.inboxTeamKeys.length).toBeGreaterThan(0);
      expect(area.special.slug).not.toBe(AREA_SPACE_SLUGS.dashboard);
      tableKeys.add(area.workCenter.tableKey);
      channels.add(area.comms.channelKey);
    }
    expect(tableKeys.size).toBe(AREA_LIST.length);
    expect(channels.size).toBe(AREA_LIST.length);
  });

  it('todas las áreas incluyen las ramas comunes y no repiten tipos de fila', () => {
    for (const area of AREA_LIST) {
      for (const kind of COMMON_ROW_KINDS) {
        expect(area.workCenter.rowKinds).toContain(kind);
      }
      expect(new Set(area.workCenter.rowKinds).size).toBe(area.workCenter.rowKinds.length);
    }
  });

  it('las subpáginas listan tipos de fila del propio centro de trabajo', () => {
    for (const area of AREA_LIST) {
      for (const subpage of area.subpages) {
        for (const kind of subpage.rowKinds) {
          expect(area.workCenter.rowKinds, `${area.key}/${subpage.slug}`).toContain(kind);
        }
      }
    }
  });

  it('los arranques del copiloto vienen de la configuración compartida', () => {
    expect(AREA_REGISTRY.inventario.copilotStarters).toContain('¿Qué verifico primero?');
    for (const area of AREA_LIST) expect(area.copilotStarters.length).toBeGreaterThan(1);
  });
});

describe('espacios', () => {
  it('ordena panel, centro de trabajo, comunicaciones, vista especial y subpáginas', () => {
    const slugs = areaSpaces(AREA_REGISTRY.compras).map((space) => space.slug);
    expect(slugs).toStrictEqual([
      'dashboard',
      'trabajo',
      'comunicaciones',
      'sourcing',
      'ordenes',
      'rfq',
      'proveedores',
    ]);
  });

  it('no repite slugs dentro de un área', () => {
    for (const area of AREA_LIST) {
      const slugs = areaSpaces(area).map((space) => space.slug);
      expect(new Set(slugs).size, area.key).toBe(slugs.length);
    }
  });

  it('marca full-bleed el trabajo, las comunicaciones y los tableros', () => {
    const flush = flushAreaRoutes();
    expect(flush).toContain('/app/areas/logistica/trabajo');
    expect(flush).toContain('/app/areas/logistica/comunicaciones');
    expect(flush).toContain('/app/areas/logistica/despacho');
    expect(flush).toContain('/app/areas/inventario/mapa');
    expect(flush).toContain('/app/areas/manufactura/tablero');
    expect(flush).not.toContain('/app/areas/ventas/radar');
    expect(flush).not.toContain('/app/areas/compras/dashboard');
  });

  it('resuelve un espacio por slug y devuelve null para lo que no existe', () => {
    const area = AREA_REGISTRY.ventas;
    expect(findAreaSpace(area, 'radar')?.kind).toBe('special');
    expect(findAreaSpace(area, 'trabajo')?.kind).toBe('work');
    expect(findAreaSpace(area, 'sourcing')).toBeNull();
    expect(findAreaSpace(area, '')).toBeNull();
    expect(findAreaSubpage(area, 'oportunidades')?.rowKinds).toStrictEqual(['opportunity']);
    expect(findAreaSubpage(area, 'ordenes')).toBeNull();
  });

  it('oculta los espacios sin permiso y los abre con operations.admin', () => {
    const area = AREA_REGISTRY.contabilidad;
    expect(visibleAreaSpaces(area, user([]))).toStrictEqual([]);
    expect(
      visibleAreaSpaces(area, user(['finance.view'])).map((space) => space.slug)
    ).toStrictEqual(['dashboard', 'trabajo', 'comunicaciones', 'libro', 'gastos']);
    expect(visibleAreaSpaces(area, user(['operations.admin'])).length).toBe(5);
    expect(visibleAreaSpaces(area, user([], true)).length).toBe(5);
  });

  it('una subpágina lista sólo sus tipos de fila', () => {
    const area = AREA_REGISTRY.compras;
    const work = findAreaSpace(area, 'trabajo');
    const subpage = findAreaSpace(area, 'ordenes');
    expect(rowKindsForSpace(area, work!)).toStrictEqual(area.workCenter.rowKinds);
    expect(rowKindsForSpace(area, subpage!)).toStrictEqual(['procurement_order']);
  });

  it('construye enlaces estables', () => {
    expect(areaHref('compras')).toBe('/app/areas/compras/dashboard');
    expect(areaHref('compras', 'trabajo')).toBe('/app/areas/compras/trabajo');
    expect(areaDetailHref('compras', 'ordenes', 'oc 1/2')).toBe(
      '/app/areas/compras/ordenes/oc%201%2F2'
    );
  });
});

describe('permisos', () => {
  it('ver el área admite sus permisos de módulo o operations.admin', () => {
    expect(areaViewPermissions(AREA_REGISTRY.ventas)).toStrictEqual([
      'crm.view',
      'sales_orders.view',
      'operations.admin',
    ]);
    expect(areaViewPermissions(AREA_REGISTRY.inventario)).toStrictEqual([
      'inventory.view',
      'operations.admin',
    ]);
  });

  it('entrar al área admite además al chofer, que no ve ningún espacio', () => {
    // El layout es una puerta gruesa: deja pasar al chofer para que su PWA exista,
    // pero `logistics.drive` NO abre trabajo, panel ni comunicaciones (piden view).
    expect(areaEntryPermissions(AREA_REGISTRY.logistica)).toStrictEqual([
      'logistics.view',
      'logistics.drive',
      'operations.admin',
    ]);
    expect(areaViewPermissions(AREA_REGISTRY.logistica)).not.toContain('logistics.drive');

    const driver = { permissionKeys: ['logistics.drive'], isSuperAdmin: false };
    expect(holdsAny(driver, areaEntryPermissions(AREA_REGISTRY.logistica))).toBe(true);
    expect(holdsAny(driver, areaViewPermissions(AREA_REGISTRY.logistica))).toBe(false);
    for (const space of areaSpaces(AREA_REGISTRY.logistica)) {
      expect(holdsAny(driver, [...space.permissions])).toBe(false);
    }
  });

  it('las demás áreas no ensanchan su puerta: entrar es ver', () => {
    for (const area of AREA_LIST.filter((candidate) => candidate.key !== 'logistica')) {
      expect(areaEntryPermissions(area)).toStrictEqual(areaViewPermissions(area));
    }
  });

  it('actuar suma los permisos transversales del núcleo', () => {
    const act = areaActPermissions(AREA_REGISTRY.logistica);
    expect(act).toContain('logistics.dispatch');
    expect(act).toContain('operations.manage');
    expect(act).toContain('operations.admin');
  });

  it('aprobar usa las llaves reales de cada área', () => {
    expect(areaApprovePermissions(AREA_REGISTRY.compras)).toContain('purchases.approve');
    expect(areaApprovePermissions(AREA_REGISTRY.manufactura)).toContain(
      'manufacturing.approve_incidents'
    );
    expect(areaApprovePermissions(AREA_REGISTRY.ventas)).toContain('crm.manage');
  });

  it('exportar es una puerta más angosta que ver donde el plan da su llave', () => {
    // Compras (plan 6.1): `purchases.view` abre el área, `purchases.export` la saca.
    expect(areaExportPermissions(AREA_REGISTRY.compras)).toStrictEqual([
      'purchases.export',
      'operations.admin',
    ]);
    const lector = user(['purchases.view']);
    expect(holdsAny(lector, areaViewPermissions(AREA_REGISTRY.compras))).toBe(true);
    expect(holdsAny(lector, areaExportPermissions(AREA_REGISTRY.compras))).toBe(false);

    const exportador = user(['purchases.view', 'purchases.export']);
    expect(holdsAny(exportador, areaExportPermissions(AREA_REGISTRY.compras))).toBe(true);

    // Ventas y Contabilidad tienen la suya; el super admin y operations.admin siempre.
    expect(areaExportPermissions(AREA_REGISTRY.ventas)).toStrictEqual([
      'crm.export',
      'sales_orders.export',
      'operations.admin',
    ]);
    expect(areaExportPermissions(AREA_REGISTRY.contabilidad)).toStrictEqual([
      'finance.export',
      'operations.admin',
    ]);
    expect(holdsAny(user([], true), areaExportPermissions(AREA_REGISTRY.compras))).toBe(true);
    expect(holdsAny(user(['operations.admin']), areaExportPermissions(AREA_REGISTRY.ventas))).toBe(
      true
    );
  });

  it('las áreas sin llave de exportación en el plan conservan la regla vieja', () => {
    // Inventario, Manufactura y Logística no tienen `*.export` en el plan: quien
    // ve el área la exporta, igual que antes de este cambio.
    for (const key of ['inventario', 'manufactura', 'logistica'] as const) {
      expect(AREA_REGISTRY[key].permissions.export).toBeUndefined();
      expect(areaExportPermissions(AREA_REGISTRY[key])).toStrictEqual(
        areaViewPermissions(AREA_REGISTRY[key])
      );
    }
  });

  it('toda llave de exportación declarada existe en el registro de permisos', () => {
    for (const area of AREA_LIST) {
      for (const key of area.permissions.export ?? []) {
        expect(isKnownPermission(key)).toBe(true);
      }
    }
  });

  it('descarta llaves que no existen en el registro', () => {
    expect(
      knownAreaPermissions(['inventory.view', 'inventory.inventado', 'inventory.view'])
    ).toStrictEqual(['inventory.view']);
  });

  it('holdsAny concede por cualquier llave o por super admin', () => {
    expect(holdsAny(user(['finance.view']), ['finance.view', 'operations.admin'])).toBe(true);
    expect(holdsAny(user(['finance.view']), ['operations.admin'])).toBe(false);
    expect(holdsAny(user([], true), ['operations.admin'])).toBe(true);
    expect(holdsAny(user([]), [])).toBe(false);
  });
});
