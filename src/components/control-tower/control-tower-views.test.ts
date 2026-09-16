import { describe, expect, it } from 'vitest';
import {
  CONTROL_TOWER_AREA_CHANNELS,
  CONTROL_TOWER_BASE_PATH,
  CONTROL_TOWER_VIEWS,
  CONTROL_TOWER_VIEW_DESCRIPTIONS,
  CONTROL_TOWER_VIEW_LABELS,
  DEFAULT_CONTROL_TOWER_VIEW,
  NEURAL_BASE_PATH,
  NEURAL_DEFAULT_TOOL,
  NEURAL_TAB_ID,
  NEURAL_TOOLS,
  controlTowerHref,
  controlTowerTabs,
  isControlTowerView,
  neuralHref,
} from './control-tower-views';
import { AREA_KEYS } from '@/modules/operations/types';

describe('control-tower-views', () => {
  it('cubre las seis vistas del plan con etiqueta y descripción', () => {
    expect(CONTROL_TOWER_VIEWS).toEqual([
      'resumen',
      'personas',
      'excepciones',
      'aprobaciones',
      'auditoria',
      'configuracion',
    ]);
    for (const view of CONTROL_TOWER_VIEWS) {
      expect(CONTROL_TOWER_VIEW_LABELS[view]).toBeTruthy();
      expect(CONTROL_TOWER_VIEW_DESCRIPTIONS[view]).toBeTruthy();
    }
    expect(CONTROL_TOWER_VIEWS).toContain(DEFAULT_CONTROL_TOWER_VIEW);
  });

  it('reconoce sólo las vistas declaradas', () => {
    expect(isControlTowerView('resumen')).toBe(true);
    expect(isControlTowerView('neural')).toBe(false);
    expect(isControlTowerView('')).toBe(false);
    expect(isControlTowerView(null)).toBe(false);
  });

  it('arma enlaces con y sin parámetros, y descarta los vacíos', () => {
    expect(controlTowerHref('personas')).toBe(`${CONTROL_TOWER_BASE_PATH}/personas`);
    expect(controlTowerHref('excepciones', { tipo: 'incident', area: '' })).toBe(
      `${CONTROL_TOWER_BASE_PATH}/excepciones?tipo=incident`
    );
    expect(controlTowerHref('excepciones', { severidad: null, page: 2 })).toBe(
      `${CONTROL_TOWER_BASE_PATH}/excepciones?page=2`
    );
  });

  it('deja la pestaña neural deshabilitada mientras sus páginas no existen', () => {
    const disabled = controlTowerTabs({ neuralEnabled: false });
    const neural = disabled.find((tab) => tab.id === NEURAL_TAB_ID);
    expect(neural?.disabled).toBe(true);
    // Nunca enlaza a una ruta que daría 404.
    expect(neural?.href).toBe('#');

    const enabled = controlTowerTabs({ neuralEnabled: true });
    const live = enabled.find((tab) => tab.id === NEURAL_TAB_ID);
    expect(live?.disabled).toBeUndefined();
    expect(live?.href).toBe(neuralHref());
  });

  it('usa una herramienta neural que existe de verdad', () => {
    // El vocabulario es el de Neural Operations, no una copia: si renombran una
    // herramienta, esto falla en vez de dejar una pestaña rota.
    expect(NEURAL_TOOLS).toContain(NEURAL_DEFAULT_TOOL);
    expect(neuralHref()).toBe(`${NEURAL_BASE_PATH}/${NEURAL_DEFAULT_TOOL}`);
  });

  it('ofrece una pestaña por vista, en orden, más la neural', () => {
    const tabs = controlTowerTabs({ neuralEnabled: true });
    expect(tabs.map((tab) => tab.id)).toEqual([...CONTROL_TOWER_VIEWS, NEURAL_TAB_ID]);
    for (const view of CONTROL_TOWER_VIEWS) {
      const tab = tabs.find((entry) => entry.id === view);
      expect(tab?.href).toBe(`${CONTROL_TOWER_BASE_PATH}/${view}`);
    }
  });

  it('escucha las seis áreas operativas (nunca administración)', () => {
    const keys = CONTROL_TOWER_AREA_CHANNELS.map((channel) => channel.split(':')[1]);
    expect(keys).toEqual(AREA_KEYS.filter((key) => key !== 'administracion'));
  });
});
