import { describe, expect, it } from 'vitest';
import { AREA_KEYS } from '@/modules/operations/types';
import {
  AREA_COPILOT_STARTERS,
  CASE_ROOM_STARTERS,
  CONTROL_TOWER_STARTERS,
  MYWORK_STARTERS,
  OPERATIONS_COPILOT_ENDPOINTS,
  areaCopilotStarters,
  areaWorkspaceHref,
  myWorkStarters,
  operationsCaseHref,
} from './copilot-starters';

describe('arranques del copiloto de operaciones', () => {
  it('cada área tiene de 3 a 5 arranques distintos y cortos', () => {
    for (const key of AREA_KEYS) {
      const starters = AREA_COPILOT_STARTERS[key];
      expect(starters.length, key).toBeGreaterThanOrEqual(3);
      expect(starters.length, key).toBeLessThanOrEqual(5);
      expect(new Set(starters).size, key).toBe(starters.length);
      for (const starter of starters) expect(starter.length, starter).toBeLessThanOrEqual(80);
    }
  });

  it('un área desconocida recibe los arranques comunes y nunca comparte el arreglo', () => {
    expect(areaCopilotStarters('marketing')).toEqual(['¿Qué está atrasado?', '¿Qué cierro hoy?']);
    const copy = areaCopilotStarters('inventario');
    copy.push('mutado');
    expect(AREA_COPILOT_STARTERS.inventario).not.toContain('mutado');
  });

  it('Mi trabajo incluye los arranques del plan', () => {
    expect(MYWORK_STARTERS).toEqual(
      expect.arrayContaining(['¿Qué hago primero?', 'Registra un conteo', '¿Qué me falta para cerrar hoy?'])
    );
    expect(CASE_ROOM_STARTERS.length).toBeGreaterThanOrEqual(3);
    expect(CONTROL_TOWER_STARTERS.length).toBeGreaterThanOrEqual(3);
  });

  it('Mi trabajo sólo ofrece registrar un conteo a quien puede contar', () => {
    expect(myWorkStarters({ canCount: true })).toContain('Registra un conteo');
    const without = myWorkStarters({ canCount: false });
    expect(without).not.toContain('Registra un conteo');
    expect(without).toHaveLength(MYWORK_STARTERS.length);
    expect(new Set(without).size).toBe(without.length);
  });

  it('no enlaza a páginas que todavía no existen (expediente, centro de trabajo)', () => {
    expect(operationsCaseHref('case-1')).toBeNull();
    expect(areaWorkspaceHref('compras')).toBeNull();
    expect(operationsCaseHref(null)).toBeNull();
  });

  it('las rutas codifican los identificadores', () => {
    expect(OPERATIONS_COPILOT_ENDPOINTS.area('inventario')).toBe('/app/operations/api/areas/inventario/copilot');
    expect(OPERATIONS_COPILOT_ENDPOINTS.case('a/b')).toBe('/app/operations/api/cases/a%2Fb/copilot');
    expect(OPERATIONS_COPILOT_ENDPOINTS.proposal('p 1')).toBe('/app/operations/api/proposals/p%201');
    expect(OPERATIONS_COPILOT_ENDPOINTS.mywork).toBe('/app/operations/api/mywork/copilot');
    expect(OPERATIONS_COPILOT_ENDPOINTS.controlTower).toBe('/app/admin/control-tower/api/copilot');
  });
});
