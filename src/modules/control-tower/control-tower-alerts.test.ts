import { describe, expect, it } from 'vitest';
import { buildControlTowerAlerts, type ControlTowerAlertInput } from './control-tower-service';
import type { AgentHealth, AgentHealthRow } from '@/modules/agents/budget';

/**
 * Alertas del resumen de la Torre de Control (plan sección 8 · E8: «alertas de
 * integración/procesos/IA/datos»). Regla pura: sin Prisma y sin reloj.
 */

const QUIET: ControlTowerAlertInput = {
  severeIncidents: 0,
  promiseBreached: 0,
  conflictDeliveries: 0,
  failedDeliveries: 0,
  failingRuns: 0,
  failingRunLabels: [],
  staleRuns: 0,
  staleRunLabels: [],
  staleRunMinutes: 120,
  failedJobs: 0,
  staleProjectionKeys: [],
  ai: null,
  aiFailureIncidents: 0,
  areasWithoutResponsible: [],
  configIncidents: 0,
  casesWithInactiveOwner: 0,
};

function agent(overrides: Partial<AgentHealthRow> = {}): AgentHealthRow {
  return {
    agentKey: 'area:compras',
    label: 'IA de Compras',
    areaKey: 'compras',
    mode: 'active',
    state: 'ok',
    pct: 10,
    tokensToday: 15_000,
    usdMonth: 1,
    dailyTokenBudget: 150_000,
    monthlyCostBudgetUsd: 40,
    ...overrides,
  };
}

function health(overrides: Partial<AgentHealth> = {}): AgentHealth {
  const agents = overrides.agents ?? [agent()];
  return {
    day: '2026-09-15',
    month: '2026-09',
    enabled: true,
    degradeAtPct: 80,
    agents,
    paused: agents.filter((row) => row.mode === 'paused'),
    degraded: agents.filter((row) => row.state === 'degraded'),
    exhausted: agents.filter((row) => row.state === 'exhausted'),
    ...overrides,
  };
}

const ids = (input: ControlTowerAlertInput) =>
  buildControlTowerAlerts(input).map((alert) => alert.id);

describe('buildControlTowerAlerts', () => {
  it('no inventa alertas cuando todo está en orden', () => {
    expect(buildControlTowerAlerts(QUIET)).toEqual([]);
    expect(buildControlTowerAlerts({ ...QUIET, ai: health() })).toEqual([]);
  });

  it('cubre las cuatro familias que pide la entrega 8 más la infraestructura', () => {
    const alerts = buildControlTowerAlerts({
      ...QUIET,
      severeIncidents: 2,
      promiseBreached: 1,
      conflictDeliveries: 1,
      failedDeliveries: 2,
      failingRuns: 1,
      failingRunLabels: ['zoho/salesorders'],
      staleRuns: 2,
      staleRunLabels: ['zoho/contact', 'zoho/item'],
      staleRunMinutes: 120,
      failedJobs: 3,
      staleProjectionKeys: ['ct_case_variant'],
      aiFailureIncidents: 1,
      areasWithoutResponsible: ['Compras', 'Manufactura'],
      configIncidents: 2,
      casesWithInactiveOwner: 4,
      ai: health({
        enabled: false,
        agents: [
          agent({ state: 'exhausted', pct: 130 }),
          agent({
            agentKey: 'area:ventas',
            label: 'IA de Ventas',
            areaKey: 'ventas',
            mode: 'paused',
          }),
        ],
      }),
    });
    const byId = new Map(alerts.map((alert) => [alert.id, alert]));
    // Procesos, integración, IA, datos e infraestructura.
    expect([...byId.keys()]).toEqual([
      'incidents_severe',
      'deliveries_conflict',
      'sync_failing',
      'sync_stale',
      'ai_budget_exhausted',
      'ai_agents_paused',
      'ai_failures',
      'ai_disabled',
      'data_responsible_missing',
      'data_config_incidents',
      'data_cases_inactive_owner',
      'jobs_failed',
      'projections_stale',
      'promise_breached',
    ]);
    expect(byId.get('ai_budget_exhausted')).toMatchObject({
      severity: 'danger',
      title: '1 identidades de IA con el presupuesto agotado',
      detail: expect.stringContaining('IA de Compras'),
    });
    expect(byId.get('ai_agents_paused')?.detail).toContain('IA de Ventas');
    expect(byId.get('data_responsible_missing')?.detail).toContain('Compras, Manufactura');
    expect(byId.get('data_cases_inactive_owner')?.title).toBe(
      '4 expedientes abiertos con un dueño dado de baja'
    );
    // Toda alerta tiene id único, severidad válida y título con contenido.
    expect(new Set(alerts.map((a) => a.id)).size).toBe(alerts.length);
    for (const alert of alerts) {
      expect(['danger', 'warning', 'info', 'success']).toContain(alert.severity);
      expect(alert.title.length).toBeGreaterThan(5);
    }
  });

  it('una integración DETENIDA avisa aunque no haya fallado nada', () => {
    // El hueco de §7.7: sólo existía `sync_failing`, y una entidad que deja de
    // correr no falla — se queda callada. Ahora tiene su propia alerta y el
    // detalle dice qué mirar.
    const alerts = buildControlTowerAlerts({
      ...QUIET,
      staleRuns: 1,
      staleRunLabels: ['zoho/contact'],
      staleRunMinutes: 120,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(['sync_stale']);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      title: '1 sincronizaciones sin correr hace más de 120 min',
    });
    expect(alerts[0].detail).toContain('zoho/contact');
    expect(alerts[0].detail).toContain('dejaron de correr');
  });

  it('el aviso de degradación calla cuando ya hay presupuestos agotados', () => {
    const degraded = agent({ state: 'degraded', pct: 85 });
    expect(ids({ ...QUIET, ai: health({ agents: [degraded] }) })).toEqual(['ai_budget_degraded']);
    expect(
      ids({ ...QUIET, ai: health({ agents: [degraded, agent({ state: 'exhausted' })] }) })
    ).toEqual(['ai_budget_exhausted']);
  });

  it('sin salud de IA (capa sin configurar) no aparece ninguna alerta de IA', () => {
    expect(ids({ ...QUIET, ai: null, aiFailureIncidents: 0, failedJobs: 1 })).toEqual([
      'jobs_failed',
    ]);
  });

  it('resume la lista de identidades cuando son muchas', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      agent({ agentKey: `area:a${i}`, label: `IA ${i}`, mode: 'paused' })
    );
    const alert = buildControlTowerAlerts({ ...QUIET, ai: health({ agents: many }) }).find(
      (row) => row.id === 'ai_agents_paused'
    );
    expect(alert?.detail).toContain('IA 0, IA 1, IA 2, +2');
  });
});
