import { describe, expect, it } from 'vitest';
import type {
  AreaLoadRow,
  ControlTowerOverview,
} from '@/modules/control-tower/control-tower-service';
import {
  areaLoadTone,
  areaPressure,
  buildControlTowerContext,
  formatCount,
  formatUsd,
  jobsTone,
  minutesAgoLabel,
  projectionLabel,
  projectionTone,
  projectionsRebuildFeedback,
  PROJECTIONS_REBUILD_ENDPOINT,
  orderSyncRuns,
  sortedAreaLoad,
  syncHealthCaption,
  syncStatusLabel,
  syncTone,
} from './overview-model';
import type { SyncHealthRow } from '@/modules/control-tower/control-tower-service';

function area(overrides: Partial<AreaLoadRow> = {}): AreaLoadRow {
  return {
    areaKey: 'ventas',
    label: 'Ventas',
    openWorkItems: 2,
    overdueWorkItems: 0,
    openRequests: 1,
    overdueRequests: 0,
    openIncidents: 0,
    aiTokens: null,
    aiUsd: null,
    ...overrides,
  };
}

function overview(): ControlTowerOverview {
  return {
    computedAt: '2026-09-15T12:00:00.000Z',
    cases: {
      open: 12,
      blocked: 2,
      waiting: 1,
      openedToday: 3,
      deliveredToday: 1,
      stuck24h: 2,
      promiseAtRisk: 1,
      promiseBreached: 0,
      byPhase: [],
    },
    work: { open: 20, overdue: 5, escalated: 1 },
    requests: { open: 4, overdue: 1, blocking: 1 },
    incidents: {
      open: 3,
      bySeverity: [
        { severity: 'critical', label: 'Crítica', count: 1 },
        { severity: 'high', label: 'Alta', count: 1 },
        { severity: 'low', label: 'Baja', count: 1 },
      ],
    },
    deliveries: { conflict: 1, pendingExternal: 0, failed: 0 },
    approvals: { pending: 2, proposals: 1 },
    areas: [
      area(),
      area({ areaKey: 'compras', label: 'Compras', overdueWorkItems: 4 }),
      area({ areaKey: 'logistica', label: 'Logística', openIncidents: 2 }),
    ],
    overdueByOwner: [{ userId: 'u1', name: 'Ana', overdue: 3 }],
    sync: { runs: [], failing: 1, stale: 0, staleMinutes: 120 },
    jobs: { pending: 3, running: 1, failed: 2, completed: 10, cancelled: 0 },
    ai: { tokensToday: 1000, usdToday: 0.5, byArea: [] },
    projections: [
      {
        key: 'variants',
        lastRunAt: '2026-09-15T11:00:00.000Z',
        minutesAgo: 60,
        lastDurationMs: 200,
        stale: true,
      },
    ],
    tiles: [],
    charts: [],
    alerts: [
      { id: 'a1', severity: 'danger', title: 'Dos entregas en conflicto' },
      { id: 'a2', severity: 'warning', title: 'Sincronización con error' },
    ],
  };
}

describe('overview-model · salud', () => {
  it('marca en rojo una corrida fallida y en ámbar una vieja', () => {
    expect(syncTone({ status: 'FAILED', errorCode: null, stale: false })).toBe('danger');
    expect(syncTone({ status: 'COMPLETED', errorCode: 'ZOHO_429', stale: false })).toBe('danger');
    expect(syncTone({ status: 'COMPLETED', errorCode: null, stale: true })).toBe('warning');
    expect(syncTone({ status: 'COMPLETED', errorCode: null, stale: false })).toBe('success');
    // El motor escribe 'FAILED'; la comparación no depende de la caja.
    expect(syncTone({ status: 'failed', errorCode: null, stale: false })).toBe('danger');
  });

  it('pone primero lo que está mal: la lista se corta a 8 y hay más entidades', () => {
    // El hueco de §7.7: la entidad que deja de sincronizar es justo la que hay
    // que ver, y ordenada alfabéticamente podía quedar fuera del corte.
    const run = (overrides: Partial<SyncHealthRow>): SyncHealthRow => ({
      source: 'zoho',
      entityType: 'item',
      status: 'COMPLETED',
      startedAt: '2026-09-15T11:00:00.000Z',
      completedAt: '2026-09-15T11:02:00.000Z',
      minutesAgo: 5,
      errorCode: null,
      recordsSeen: 3,
      stale: false,
      ...overrides,
    });
    const ordered = orderSyncRuns([
      run({ entityType: 'aaa_sana' }),
      run({ entityType: 'zzz_vieja', stale: true, minutesAgo: 900 }),
      run({ entityType: 'mmm_fallida', status: 'FAILED', errorCode: 'ZOHO_API_ERROR' }),
      run({ entityType: 'bbb_sana', source: 'alpha' }),
    ]);
    expect(ordered.map((row) => row.entityType)).toStrictEqual([
      'mmm_fallida',
      'zzz_vieja',
      'bbb_sana',
      'aaa_sana',
    ]);
    // Pura: no toca el arreglo que recibe.
    const input = [run({ entityType: 'b' }), run({ entityType: 'a' })];
    orderSyncRuns(input);
    expect(input.map((row) => row.entityType)).toStrictEqual(['b', 'a']);
  });

  it('el pie de la tarjeta dice cuántas fallan y cuántas dejaron de correr', () => {
    expect(syncHealthCaption({ runs: [], failing: 0, stale: 0, staleMinutes: 120 })).toBe(
      'Última corrida por entidad.'
    );
    expect(syncHealthCaption({ runs: [], failing: 2, stale: 0, staleMinutes: 120 })).toBe(
      'Última corrida por entidad: 2 con error.'
    );
    expect(syncHealthCaption({ runs: [], failing: 0, stale: 1, staleMinutes: 120 })).toBe(
      'Última corrida por entidad: 1 sin correr hace más de 120 min.'
    );
    expect(syncHealthCaption({ runs: [], failing: 1, stale: 3, staleMinutes: 120 })).toBe(
      'Última corrida por entidad: 1 con error y 3 sin correr hace más de 120 min.'
    );
  });

  it('traduce el estado de una corrida y deja pasar uno desconocido', () => {
    expect(syncStatusLabel('COMPLETED')).toBe('Completada');
    expect(syncStatusLabel('RARO')).toBe('RARO');
  });

  it('marca la cola de trabajos por fallidos y por acumulación', () => {
    expect(jobsTone({ pending: 0, running: 0, failed: 1, completed: 0, cancelled: 0 })).toBe(
      'danger'
    );
    expect(jobsTone({ pending: 80, running: 0, failed: 0, completed: 0, cancelled: 0 })).toBe(
      'warning'
    );
    expect(jobsTone({ pending: 1, running: 1, failed: 0, completed: 5, cancelled: 0 })).toBe(
      'success'
    );
  });

  it('marca una proyección vieja y nombra las cuatro conocidas', () => {
    expect(projectionTone({ stale: true })).toBe('warning');
    expect(projectionTone({ stale: false })).toBe('success');
    expect(projectionLabel('step_metrics')).toBe('Métricas por paso');
    expect(projectionLabel('otra')).toBe('otra');
  });

  it('traduce minutos a una frase, sin números negativos', () => {
    expect(minutesAgoLabel(null)).toBe('sin registro');
    expect(minutesAgoLabel(-5)).toBe('hace un momento');
    expect(minutesAgoLabel(30)).toBe('hace 30 min');
    expect(minutesAgoLabel(200)).toBe('hace 3 h');
    expect(minutesAgoLabel(60 * 50)).toBe('hace 2 d');
  });
});

describe('overview-model · carga por área', () => {
  it('pesa lo vencido por encima de lo abierto', () => {
    expect(areaPressure(area({ overdueWorkItems: 1, openWorkItems: 0, openRequests: 0 }))).toBe(3);
    expect(areaPressure(area({ overdueWorkItems: 0, openWorkItems: 2, openRequests: 1 }))).toBe(3);
  });

  it('ordena primero el área con más presión y mantiene el orden ante empates', () => {
    const sorted = sortedAreaLoad(overview().areas);
    expect(sorted[0].areaKey).toBe('compras');
    expect(sorted[1].areaKey).toBe('logistica');
  });

  it('da tono rojo a lo vencido y ámbar a las incidencias', () => {
    expect(areaLoadTone(area({ overdueRequests: 1 }))).toBe('danger');
    expect(areaLoadTone(area({ openIncidents: 1 }))).toBe('warning');
    expect(areaLoadTone(area())).toBe('default');
  });
});

describe('overview-model · contexto del copiloto', () => {
  const context = buildControlTowerContext(overview(), 'resumen');

  it('manda la superficie, la vista y los números que ya están en pantalla', () => {
    expect(context.surface).toBe('control_tower');
    expect(context.view).toBe('resumen');
    expect(context.work.overdue).toBe(5);
    expect(context.incidents).toEqual({ open: 3, severe: 2 });
  });

  it('manda las áreas ordenadas por presión y sin datos personales', () => {
    expect(context.areas[0].areaKey).toBe('compras');
    expect(JSON.stringify(context)).not.toContain('Ana');
  });

  it('resume la salud técnica y acota las alertas', () => {
    expect(context.health).toEqual({
      syncFailing: 1,
      jobsFailed: 2,
      staleProjections: ['variants'],
    });
    expect(context.alerts).toHaveLength(2);
  });
});

describe('overview-model · formatos', () => {
  it('formatea importes y conteos en español de México', () => {
    expect(formatUsd(1234.5)).toContain('1,234.5');
    expect(formatCount(12345)).toBe('12,345');
    expect(formatCount(Number.NaN)).toBe('0');
  });
});

describe('overview-model · recálculo de proyecciones (plan 7.9)', () => {
  it('apunta a la ruta que ya existía y que nadie llamaba', () => {
    expect(PROJECTIONS_REBUILD_ENDPOINT).toBe('/app/admin/control-tower/api/projections/rebuild');
  });

  it('encolar avisa que tarda unos minutos y no promete un resultado', () => {
    const feedback = projectionsRebuildFeedback({ mode: 'queued', job: { id: 'j1' } });
    expect(feedback.tone).toBe('success');
    expect(feedback.message).toContain('encolado');
    expect(feedback.detail).toBeNull();
  });

  it('en línea resume qué escribió cada proyección', () => {
    const feedback = projectionsRebuildFeedback({
      mode: 'inline',
      result: {
        full: true,
        failed: 0,
        runs: [
          { key: 'variants', ok: true, written: 12, detail: '12 expediente(s)' },
          { key: 'handoffs', ok: true, written: 5, detail: '5 fila(s) en 2 día(s)' },
        ],
      },
    });
    expect(feedback.tone).toBe('success');
    expect(feedback.message).toContain('17');
    expect(feedback.detail).toContain('Variantes de proceso');
    expect(feedback.detail).toContain('Traspasos entre áreas');
  });

  it('una proyección que falla no se disfraza de éxito', () => {
    const feedback = projectionsRebuildFeedback({
      mode: 'inline',
      result: {
        failed: 1,
        runs: [
          { key: 'variants', ok: false, error: 'timeout' },
          { key: 'handoffs', ok: true, written: 3, detail: '3 fila(s)' },
        ],
      },
    });
    expect(feedback.tone).toBe('error');
    expect(feedback.message).toContain('Una proyección falló');
    expect(feedback.detail).toContain('timeout');
  });

  it('un 403 o un cuerpo vacío se dicen en español y no se tragan', () => {
    expect(projectionsRebuildFeedback({ error: 'No tienes acceso' }, { ok: false })).toEqual({
      tone: 'error',
      message: 'No tienes acceso',
      detail: null,
    });
    expect(projectionsRebuildFeedback(null, { ok: false }).message).toContain(
      'No pudimos pedir el recálculo'
    );
  });
});
