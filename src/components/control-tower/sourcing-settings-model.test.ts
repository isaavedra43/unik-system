import { describe, expect, it } from 'vitest';
import {
  defaultSourcingSettings,
  normalizeSourcingSettings,
  sourcingConfigPatchSchema,
  type SourcingConfig,
} from '@/modules/purchases/sourcing-config';
import {
  SOURCING_BOUNDS,
  parseAllowedHosts,
  sourcingConfigWarnings,
  sourcingFormToPatch,
  toSourcingForm,
  type SourcingSettingsForm,
} from './sourcing-settings-model';

function config(overrides: Partial<SourcingConfig> = {}): SourcingConfig {
  return {
    ...defaultSourcingSettings(),
    isEnabled: true,
    updatedAt: null,
    ...overrides,
  };
}

function form(overrides: Partial<SourcingSettingsForm> = {}): SourcingSettingsForm {
  return { ...toSourcingForm(config()), ...overrides };
}

describe('parseAllowedHosts', () => {
  it('quita el esquema y la ruta, baja a minúsculas y deduplica', () => {
    const result = parseAllowedHosts('https://Proveedor.com/catalogo\n*.otro.com\nproveedor.com');
    expect(result.ok).toBe(true);
    expect(result.values).toEqual(['proveedor.com', '*.otro.com']);
  });

  it('señala en español lo que no es un dominio', () => {
    const result = parseAllowedHosts('proveedor.com\nlocalhost\nno es un host');
    expect(result.ok).toBe(false);
    expect(result.values).toEqual(['proveedor.com']);
    expect(result.invalid).toContain('localhost');
  });

  it('una lista vacía es válida (es el valor por omisión)', () => {
    expect(parseAllowedHosts('  \n ')).toEqual({ ok: true, values: [], invalid: [] });
  });
});

describe('sourcingFormToPatch', () => {
  it('construye un parche que el esquema del servidor acepta', () => {
    const result = sourcingFormToPatch(
      form({
        allowedHosts: 'proveedor.com\n*.catalogo.mx',
        dailyBudgetUnits: '150',
        rfqTemplateKey: 'HX123',
        rfqAccountId: ' acc_1 ',
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = sourcingConfigPatchSchema.safeParse(result.patch);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(result.patch.allowedHosts).toEqual(['proveedor.com', '*.catalogo.mx']);
    expect(result.patch.rfqAccountId).toBe('acc_1');
    expect(result.patch.rfqTemplateKey).toBe('HX123');
  });

  it('un campo vacío de id se guarda como null, no como cadena vacía', () => {
    const result = sourcingFormToPatch(form({ rfqAccountId: '   ', braveConnectionId: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.rfqAccountId).toBeNull();
    expect(result.patch.braveConnectionId).toBeNull();
    expect(sourcingConfigPatchSchema.safeParse(result.patch).success).toBe(true);
  });

  it('rechaza los números fuera de rango con un mensaje en español', () => {
    const result = sourcingFormToPatch(
      form({ dailyBudgetUnits: '-1', maxPagesPerSearch: '9', cacheTtlDays: 'x' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('Presupuesto diario');
    expect(result.errors.join(' ')).toContain('Páginas por búsqueda');
    expect(result.errors.join(' ')).toContain('Caché');
  });

  it('rechaza un texto de plantilla demasiado corto', () => {
    const result = sourcingFormToPatch(form({ rfqMessageTemplate: 'corto' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('Texto de la cotización');
  });

  it('el ida y vuelta conserva la configuración tal cual', () => {
    const original = config({
      allowedHosts: ['proveedor.com'],
      dailyBudgetUnits: 42,
      rfqTemplateKey: 'HX1',
      orderTemplateKey: 'HX2',
      braveConnectionId: 'conn_1',
      rfqAccountId: 'acc_1',
    });
    const result = sourcingFormToPatch(toSourcingForm(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = normalizeSourcingSettings({
      ...defaultSourcingSettings(),
      ...result.patch,
    });
    expect(stored.allowedHosts).toEqual(original.allowedHosts);
    expect(stored.dailyBudgetUnits).toBe(42);
    expect(stored.rfqTemplateKey).toBe('HX1');
    expect(stored.orderTemplateKey).toBe('HX2');
    expect(stored.braveConnectionId).toBe('conn_1');
    expect(stored.rfqAccountId).toBe('acc_1');
  });

  it('los límites del formulario son los mismos que valida el servidor', () => {
    for (const [field, bounds] of Object.entries(SOURCING_BOUNDS)) {
      const tooHigh = sourcingConfigPatchSchema.safeParse({ [field]: bounds.max + 1 });
      const tooLow = sourcingConfigPatchSchema.safeParse({ [field]: bounds.min - 1 });
      const inRange = sourcingConfigPatchSchema.safeParse({ [field]: bounds.max });
      expect(tooHigh.success, `${field} máximo`).toBe(false);
      expect(tooLow.success, `${field} mínimo`).toBe(false);
      expect(inRange.success, `${field} en rango`).toBe(true);
    }
  });
});

describe('sourcingConfigWarnings', () => {
  it('con los valores por omisión explica por qué el laboratorio no sale a internet', () => {
    const warnings = sourcingConfigWarnings(config());
    expect(warnings.join(' ')).toContain('Sin sitios autorizados');
    expect(warnings.join(' ')).toContain('Sin plantilla aprobada de cotización');
  });

  it('con todo configurado no advierte nada', () => {
    const warnings = sourcingConfigWarnings(
      config({
        allowedHosts: ['proveedor.com'],
        rfqTemplateKey: 'HX1',
        orderTemplateKey: 'HX2',
        braveConnectionId: 'conn_1',
        rfqAccountId: 'acc_1',
      })
    );
    expect(warnings).toEqual([]);
  });

  it('avisa cuando el laboratorio está apagado', () => {
    expect(sourcingConfigWarnings(config({ isEnabled: false })).join(' ')).toContain('apagado');
  });
});
