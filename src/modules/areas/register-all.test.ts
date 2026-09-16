import { afterEach, describe, expect, it, vi } from 'vitest';
import { AREA_WORKSPACE_KEYS, AREA_REGISTRY } from './area-registry';
import {
  areaWorkBranches,
  availableRowKinds,
  getAreaServer,
  isAreaServerRegistered,
  registerAreaServer,
  registeredAreaKeys,
  resetAreaServerRegistry,
} from './area-server-registry';
import { ensureAreaRegistrations, resetAreaRegistrations } from './register-all';
import { areaWorkRowSelect } from './work-rows-sql';

/**
 * The barrel must tolerate the areas whose server module does not exist yet:
 * an area without `src/modules/areas/<area>/register.ts` keeps working with the
 * common branches, so the work centre is never broken by a module that is still
 * being written.
 */

afterEach(() => {
  resetAreaRegistrations();
  resetAreaServerRegistry();
  vi.restoreAllMocks();
});

describe('ensureAreaRegistrations', () => {
  it('carga de verdad el módulo de las seis áreas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await ensureAreaRegistrations();
    expect(results.map((result) => result.key)).toStrictEqual([...AREA_WORKSPACE_KEYS]);
    // Every area ships its register.ts, and the barrel imports them literally, so all six must load.
    // A template import resolved under Webpack but not under Vite: the registrations vanished here in
    // silence and nobody noticed until a build ran. This assertion is what makes that impossible.
    const failed = results
      .filter((result) => !result.registered)
      .map((result) => `${result.key}: ${result.error}`);
    expect(failed).toStrictEqual([]);
    expect(registeredAreaKeys().sort()).toStrictEqual([...AREA_WORKSPACE_KEYS].sort());
  });

  it('un módulo que falla no tumba a los demás', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await ensureAreaRegistrations();
    for (const result of results) {
      // Registered or not, nothing throws and the error is kept for diagnostics.
      expect(typeof result.registered).toBe('boolean');
      if (!result.registered) expect(result.error).toBeTruthy();
    }
  });

  it('es idempotente: la segunda llamada no vuelve a importar', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const first = await ensureAreaRegistrations();
    const second = await ensureAreaRegistrations();
    expect(second).toBe(first);
  });
});

describe('registro de servidor por área', () => {
  it('sin módulo propio un área conserva las ramas comunes', () => {
    const area = AREA_REGISTRY.contabilidad;
    expect(isAreaServerRegistered(area.key)).toBe(false);
    expect(getAreaServer(area.key)).toStrictEqual({});
    expect(areaWorkBranches(area).map((branch) => branch.rowKind)).toStrictEqual([
      'work_item',
      'request_in',
      'request_out',
    ]);
    expect(availableRowKinds(area)).toStrictEqual(['work_item', 'request_in', 'request_out']);
  });

  it('un área registrada suma sus ramas declaradas y descarta las que no declara', () => {
    const area = AREA_REGISTRY.compras;
    const branch = (rowKind: string) => ({
      rowKind,
      sql: () =>
        areaWorkRowSelect({
          rowKind,
          from: { strings: [''], values: [] } as never,
          where: { strings: [''], values: [] } as never,
          columns: {},
        }),
    });
    registerAreaServer('compras', {
      workRowBranches: [branch('procurement_order'), branch('tipo_inventado')],
    });

    expect(registeredAreaKeys()).toStrictEqual(['compras']);
    const kinds = areaWorkBranches(area).map((entry) => entry.rowKind);
    expect(kinds).toContain('procurement_order');
    expect(kinds).not.toContain('tipo_inventado');
    expect(availableRowKinds(area)).toStrictEqual([
      'work_item',
      'request_in',
      'request_out',
      'procurement_order',
    ]);
  });

  it('volver a registrar reemplaza el módulo (recarga en caliente)', () => {
    registerAreaServer('ventas', { workRowBranches: [] });
    const dashboard = vi.fn();
    registerAreaServer('ventas', { loadDashboard: dashboard as never });
    expect(getAreaServer('ventas').loadDashboard).toBe(dashboard);
    expect(getAreaServer('ventas').workRowBranches).toBeUndefined();
  });
});
