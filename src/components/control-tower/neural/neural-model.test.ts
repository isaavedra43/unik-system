import { describe, expect, it } from 'vitest';
import {
  areaLegend,
  areaTone,
  barWidth,
  breachTone,
  conformanceTone,
  DEFAULT_RANGE_KEY,
  formatCount,
  formatMinutes,
  formatMinutesAgo,
  formatPercent,
  formatRatio,
  freshnessLabel,
  isNeuralTool,
  neuralHref,
  NEURAL_TOOLS,
  NEURAL_TOOL_LIST,
  parseRange,
  rangeFromPreset,
  toDayKey,
} from './neural-model';

describe('herramientas', () => {
  it('reconoce las cinco del plan y rechaza cualquier otra', () => {
    expect([...NEURAL_TOOLS]).toEqual(['procesos', 'variantes', 'grafo', 'replay', 'simulacion']);
    for (const tool of NEURAL_TOOLS) expect(isNeuralTool(tool)).toBe(true);
    expect(isNeuralTool('procesos/../../admin')).toBe(false);
    expect(isNeuralTool(null)).toBe(false);
    expect(isNeuralTool('')).toBe(false);
  });

  it('el catálogo describe cada herramienta una sola vez', () => {
    expect(NEURAL_TOOL_LIST).toHaveLength(NEURAL_TOOLS.length);
    const keys = NEURAL_TOOL_LIST.map((tool) => tool.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of NEURAL_TOOL_LIST) expect(tool.description.length).toBeGreaterThan(10);
  });

  it('arma enlaces omitiendo parámetros vacíos', () => {
    expect(neuralHref('grafo')).toBe('/app/admin/control-tower/neural/grafo');
    expect(neuralHref('replay', { caso: 'c1', at: null, vacio: '   ' })).toBe(
      '/app/admin/control-tower/neural/replay?caso=c1'
    );
    expect(neuralHref('variantes', { rango: '7d', area: 'compras' })).toContain('rango=7d');
  });

  it('escapa lo que escribe una persona en el enlace', () => {
    expect(neuralHref('grafo', { raiz: 'a b&c=d' })).toBe(
      '/app/admin/control-tower/neural/grafo?raiz=a+b%26c%3Dd'
    );
  });
});

describe('formatos', () => {
  it('nunca muestra cero cuando no hay medición', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(undefined)).toBe('—');
    expect(formatMinutes(Number.NaN)).toBe('—');
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatCount(null)).toBe('—');
    expect(formatPercent(null)).toBe('—');
    expect(formatRatio(null)).toBe('—');
  });

  it('escala los minutos a horas y días', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(150)).toBe('2 h 30 min');
    expect(formatMinutes(1440)).toBe('1 d');
    expect(formatMinutes(1740)).toBe('1 d 5 h');
  });

  it('formatea porcentajes y proporciones', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(50, 0)).toBe('50%');
    expect(formatRatio(0.923, 1)).toBe('92.3%');
  });

  it('dice la antigüedad en lenguaje de operación', () => {
    expect(formatMinutesAgo(null)).toBe('nunca');
    expect(formatMinutesAgo(0.2)).toBe('hace unos segundos');
    expect(formatMinutesAgo(3)).toBe('hace 3 min');
    expect(formatMinutesAgo(150)).toBe('hace 2 h 30 min');
  });

  it('el día es el calendario UTC de las proyecciones', () => {
    expect(toDayKey('2026-03-12T23:30:00.000Z')).toBe('2026-03-12');
    expect(toDayKey(null)).toBe('');
  });
});

describe('rangos', () => {
  const now = new Date('2026-03-31T18:00:00.000Z');

  it('un preajuste termina hoy e incluye el día completo', () => {
    expect(rangeFromPreset('7d', now)).toEqual({ from: '2026-03-25', to: '2026-03-31' });
    expect(rangeFromPreset('30d', now)).toEqual({ from: '2026-03-02', to: '2026-03-31' });
  });

  it('un preajuste desconocido cae al de 30 días', () => {
    expect(rangeFromPreset('nunca-existió', now)).toEqual(rangeFromPreset('30d', now));
  });

  it('las fechas explícitas mandan y se enderezan si vienen al revés', () => {
    expect(parseRange({ desde: '2026-01-10', hasta: '2026-01-01' }, now)).toEqual({
      from: '2026-01-01',
      to: '2026-01-10',
      presetKey: null,
    });
  });

  it('una fecha inválida no rompe la página: usa el preajuste', () => {
    const parsed = parseRange({ desde: 'ayer', hasta: '2026-01-01' }, now);
    expect(parsed.presetKey).toBe(DEFAULT_RANGE_KEY);
    expect(parsed.from).toBe('2026-03-02');
  });
});

describe('tonos', () => {
  it('el incumplimiento sin datos se queda neutro', () => {
    expect(breachTone(null)).toBe('default');
    expect(breachTone(2)).toBe('success');
    expect(breachTone(15)).toBe('warning');
    expect(breachTone(40)).toBe('danger');
  });

  it('la conformidad sin datos se queda neutra', () => {
    expect(conformanceTone(null)).toBe('default');
    expect(conformanceTone(99)).toBe('success');
    expect(conformanceTone(85)).toBe('warning');
    expect(conformanceTone(10)).toBe('danger');
  });

  it('una barra con valor siempre se ve, y sin valor no se dibuja', () => {
    expect(barWidth(0, 100)).toBe(0);
    expect(barWidth(1, 10_000)).toBe(2);
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(500, 100)).toBe(100);
    expect(barWidth(5, 0)).toBe(0);
  });

  it('cada área tiene color propio y las desconocidas quedan neutras', () => {
    expect(areaTone('compras')).not.toBe(areaTone('ventas'));
    expect(areaTone('marte')).toBe('muted');
    expect(areaTone(null)).toBe('muted');
  });

  it('la leyenda no repite áreas y traduce la clave', () => {
    const legend = areaLegend(['compras', 'compras', null, 'ventas']);
    expect(legend.map((entry) => entry.key)).toEqual(['compras', 'sin_area', 'ventas']);
    expect(legend[0]?.label).toBe('Compras');
    expect(legend[1]?.label).toBe('Sin área');
  });
});

describe('frescura de las proyecciones', () => {
  it('reporta la más vieja', () => {
    expect(
      freshnessLabel([
        { label: 'Variantes', minutesAgo: 3, stale: false },
        { label: 'Pasos', minutesAgo: 42, stale: false },
      ])
    ).toBe('Proyecciones actualizadas hace 42 min');
  });

  it('no dice que algo está fresco cuando nunca se calculó', () => {
    expect(
      freshnessLabel([
        { label: 'Variantes', minutesAgo: null, stale: true },
        { label: 'Pasos', minutesAgo: null, stale: true },
      ])
    ).toBe('Sin proyecciones calculadas todavía.');
    expect(
      freshnessLabel([
        { label: 'Variantes', minutesAgo: 5, stale: false },
        { label: 'Pasos', minutesAgo: null, stale: true },
      ])
    ).toContain('1 sin calcular');
  });

  it('avisa cuando el job va atrasado', () => {
    expect(freshnessLabel([{ label: 'Variantes', minutesAgo: 180, stale: true }])).toContain(
      'atrasadas'
    );
  });
});
