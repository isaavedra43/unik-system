import { describe, expect, it } from 'vitest';
import {
  ventasAlerts,
  ventasCharts,
  ventasTiles,
  VENTAS_LIVE_TILES,
  type VentasDashboardCounts,
} from './dashboard-model';
import { formatMoney, formatProbability } from './ventas-constants';

const NOW = new Date('2026-09-15T18:00:00.000Z');

function counts(overrides: Partial<VentasDashboardCounts> = {}): VentasDashboardCounts {
  return {
    openCases: 12,
    blockedCases: 2,
    promisedAtRisk: 3,
    quotesWaiting: 7,
    ordersWithoutCase: 1,
    activeSignals: 9,
    overdueOutgoingRequests: 4,
    monthSalesTotal: 1_250_000,
    monthSalesOrders: 18,
    ...overrides,
  };
}

describe('ventasTiles', () => {
  it('devuelve los ocho tiles del plan en orden y con enlaces reales', () => {
    const tiles = ventasTiles(counts(), NOW);
    expect(tiles.map((tile) => tile.id)).toStrictEqual([
      'open_cases',
      'blocked_cases',
      'promised_at_risk',
      'quotes_waiting',
      'orders_without_case',
      'radar_signals',
      'requests_overdue',
      'month_sales',
    ]);
    expect(tiles.every((tile) => typeof tile.value === 'string' && tile.value.length > 0)).toBe(
      true
    );
    expect(tiles.find((tile) => tile.id === 'radar_signals')?.href).toBe('/app/areas/ventas/radar');
    expect(tiles.find((tile) => tile.id === 'open_cases')?.href).toBe(
      '/app/areas/ventas/trabajo?kind=case'
    );
    expect(tiles.find((tile) => tile.id === 'requests_overdue')?.href).toBe(
      '/app/areas/ventas/trabajo?kind=request_out&vencidos=1'
    );
  });

  it('marca en vivo exactamente los tres tiles baratos', () => {
    const live = ventasTiles(counts(), NOW)
      .filter((tile) => tile.live)
      .map((tile) => tile.id);
    expect(live).toStrictEqual([...VENTAS_LIVE_TILES]);
    expect(live.length).toBeLessThanOrEqual(3);
  });

  it('un área sin nada pendiente muestra ceros y tono positivo, nunca datos inventados', () => {
    const tiles = ventasTiles(
      counts({
        openCases: 0,
        blockedCases: 0,
        promisedAtRisk: 0,
        quotesWaiting: 0,
        ordersWithoutCase: 0,
        activeSignals: 0,
        overdueOutgoingRequests: 0,
        monthSalesTotal: 0,
        monthSalesOrders: 0,
      }),
      NOW
    );
    expect(tiles.find((tile) => tile.id === 'blocked_cases')).toMatchObject({
      value: '0',
      tone: 'success',
    });
    expect(tiles.find((tile) => tile.id === 'orders_without_case')?.tone).toBe('success');
    expect(tiles.find((tile) => tile.id === 'requests_overdue')?.tone).toBe('default');
    expect(tiles.find((tile) => tile.id === 'month_sales')?.value).toBe('$0.00');
  });

  it('sube el tono cuando hay bloqueos, riesgo o solicitudes vencidas', () => {
    const tiles = ventasTiles(counts(), NOW);
    expect(tiles.find((tile) => tile.id === 'blocked_cases')?.tone).toBe('danger');
    expect(tiles.find((tile) => tile.id === 'promised_at_risk')?.tone).toBe('warning');
    expect(tiles.find((tile) => tile.id === 'requests_overdue')?.tone).toBe('danger');
  });
});

describe('ventasCharts', () => {
  it('arma la tendencia de 30 días y el reparto por fase sin fases vacías', () => {
    const charts = ventasCharts(
      [
        { label: '01/09', creados: 2, cerrados: 1 },
        { label: '02/09', creados: 0, cerrados: 3 },
      ],
      [
        { phase: 'planning', total: 4 },
        { phase: 'delivering', total: 2 },
        { phase: 'closing', total: 0 },
      ]
    );
    expect(charts).toHaveLength(2);
    const [trend, status] = charts;
    expect(trend.kind).toBe('trend');
    if (trend.kind === 'trend') {
      expect(trend.data).toHaveLength(2);
      expect(trend.series.map((serie) => serie.key)).toStrictEqual(['creados', 'cerrados']);
    }
    expect(status.kind).toBe('status');
    if (status.kind === 'status') {
      expect(status.segments.map((segment) => segment.key)).toStrictEqual([
        'planning',
        'delivering',
      ]);
      expect(status.segments[0]).toMatchObject({ label: 'Planeación', count: 4 });
    }
  });

  it('sin expedientes abiertos la gráfica de fases queda vacía (el panel muestra su estado vacío)', () => {
    const [, status] = ventasCharts([], []);
    if (status.kind === 'status') expect(status.segments).toStrictEqual([]);
  });
});

describe('ventasAlerts', () => {
  it('ordena bloqueados, promesas y solicitudes, y corta en seis', () => {
    const alerts = ventasAlerts({
      blocked: [
        {
          id: 'c1',
          caseNumber: 'EXP-1',
          customerName: 'Aceros del Norte',
          since: '2026-09-10T12:00:00.000Z',
        },
      ],
      promised: [
        {
          id: 'c2',
          caseNumber: 'EXP-2',
          customerName: 'Constructora Sur',
          promisedAt: '2026-09-14T12:00:00.000Z',
          overdue: true,
        },
        {
          id: 'c3',
          caseNumber: 'EXP-3',
          customerName: null,
          promisedAt: '2026-09-16T12:00:00.000Z',
          overdue: false,
        },
      ],
      requests: [
        {
          id: 'r1',
          title: 'Confirmar existencia',
          toAreaLabel: 'Inventario',
          dueAt: '2026-09-13T12:00:00.000Z',
        },
        {
          id: 'r2',
          title: 'Comprar perfil',
          toAreaLabel: 'Compras',
          dueAt: '2026-09-12T12:00:00.000Z',
        },
        {
          id: 'r3',
          title: 'Programar entrega',
          toAreaLabel: 'Logística',
          dueAt: '2026-09-11T12:00:00.000Z',
        },
        {
          id: 'r4',
          title: 'Autorizar pago',
          toAreaLabel: 'Contabilidad',
          dueAt: '2026-09-10T12:00:00.000Z',
        },
      ],
    });
    expect(alerts).toHaveLength(6);
    expect(alerts[0]).toMatchObject({ id: 'case-blocked-c1', severity: 'danger' });
    expect(alerts[1]).toMatchObject({ id: 'case-promised-c2', severity: 'danger' });
    expect(alerts[2]).toMatchObject({ id: 'case-promised-c3', severity: 'warning' });
    expect(alerts[3].id).toBe('request-r1');
    expect(alerts[3].detail).toContain('Inventario');
  });

  it('sin nada abierto no inventa alertas', () => {
    expect(ventasAlerts({ blocked: [], promised: [], requests: [] })).toStrictEqual([]);
  });
});

describe('formatos', () => {
  it('formatea dinero y probabilidad en español, y tolera valores ausentes', () => {
    expect(formatMoney(1500)).toContain('1,500');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('no-es-numero')).toBe('—');
    expect(formatProbability(0.35)).toBe('35 %');
    expect(formatProbability(null)).toBe('—');
    expect(formatProbability(2)).toBe('100 %');
  });
});
