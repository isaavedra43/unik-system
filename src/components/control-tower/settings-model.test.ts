import { describe, expect, it } from 'vitest';
import {
  OPS_FLAGS,
  OPS_FLAG_LABELS,
  defaultOperationsSettings,
  operationsConfigPatchSchema,
  type OperationsConfig,
} from '@/modules/operations/operations-config';
import { WORK_ITEM_KINDS } from '@/modules/operations/types';
import {
  CT_OPS_FLAGS,
  CT_OPS_FLAG_DESCRIPTIONS,
  CT_OPS_FLAG_LABELS,
  CT_OPS_FLAG_OFF_WARNINGS,
  describeEscalation,
  flagsBeingDisabled,
  isKillSwitchOff,
  parseMinutesList,
  parsePilotLocationIds,
  settingsFormToPatch,
  toSettingsForm,
} from './settings-model';

function config(overrides: Partial<OperationsConfig> = {}): OperationsConfig {
  const settings = defaultOperationsSettings(new Date('2026-09-15T12:00:00.000Z'));
  return { ...settings, isEnabled: true, updatedAt: '2026-09-15T12:00:00.000Z', ...overrides };
}

describe('settings-model · espejo de la configuración', () => {
  it('replica exactamente los indicadores del núcleo', () => {
    expect([...CT_OPS_FLAGS]).toEqual([...OPS_FLAGS]);
  });

  it('replica sus etiquetas y describe cada uno', () => {
    for (const flag of OPS_FLAGS) {
      expect(CT_OPS_FLAG_LABELS[flag]).toBe(OPS_FLAG_LABELS[flag]);
      expect(CT_OPS_FLAG_DESCRIPTIONS[flag]).toBeTruthy();
      expect(CT_OPS_FLAG_OFF_WARNINGS[flag]).toBeTruthy();
    }
  });
});

describe('settings-model · formulario', () => {
  it('convierte la configuración en campos de formulario', () => {
    const form = toSettingsForm(config());
    expect(form.cutoverDate).toBe('2026-09-15');
    expect(form.escalationAfterMinutes).toBe('0, 120, 480');
    expect(form.escalationLadder).toEqual(['backup', 'area_lead', 'administracion']);
    expect(form.slaDefaults.action).toBe('240');
    expect(form.pilotLocationIds).toBe('');
  });

  it('produce un patch que el esquema del núcleo acepta', () => {
    const result = settingsFormToPatch(toSettingsForm(config()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => operationsConfigPatchSchema.parse(result.patch)).not.toThrow();
    for (const kind of WORK_ITEM_KINDS) {
      expect(result.patch.slaDefaults?.[kind]).toBeTypeOf('number');
    }
  });

  it('conserva el día elegido en la fecha de corte', () => {
    const form = { ...toSettingsForm(config()), cutoverDate: '2026-01-31' };
    const result = settingsFormToPatch(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.patch.cutoverDate).slice(0, 10)).toBe('2026-01-31');
  });

  it('junta TODOS los errores en vez de parar en el primero', () => {
    const form = {
      ...toSettingsForm(config()),
      cutoverDate: 'ayer',
      escalationAfterMinutes: '480, 0',
      expenseAutoApproveMxn: 'mucho',
    };
    const result = settingsFormToPatch(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors.some((error) => error.includes('Fecha de corte'))).toBe(true);
    expect(result.errors.some((error) => error.includes('menor a mayor'))).toBe(true);
  });

  it('exige al menos un peldaño de escalera', () => {
    const result = settingsFormToPatch({ ...toSettingsForm(config()), escalationLadder: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes('peldaño'))).toBe(true);
  });

  it('limpia y deduplica las bodegas piloto', () => {
    const result = settingsFormToPatch({
      ...toSettingsForm(config()),
      pilotLocationIds: ' 111 \n222\n111\n\n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.pilotLocationIds).toEqual(['111', '222']);
  });
});

describe('settings-model · ayudas', () => {
  it('valida la lista de minutos', () => {
    expect(parseMinutesList('0, 120, 480')).toEqual({
      ok: true,
      values: [0, 120, 480],
      error: null,
    });
    expect(parseMinutesList('').ok).toBe(false);
    expect(parseMinutesList('120, 60').error).toContain('menor a mayor');
    expect(parseMinutesList('abc').error).toContain('no es un número');
  });

  it('acepta comas y saltos de línea en las bodegas', () => {
    expect(parsePilotLocationIds('a, b\nc').values).toEqual(['a', 'b', 'c']);
    expect(parsePilotLocationIds('x'.repeat(200)).ok).toBe(false);
  });

  it('nombra los indicadores que se están apagando', () => {
    const current = config();
    const form = toSettingsForm(current);
    form.flags.logistics = false;
    form.flags.supervisor = false;
    expect(flagsBeingDisabled(current, form)).toEqual(['logistics', 'supervisor']);
    expect(isKillSwitchOff(current, form)).toBe(false);
    expect(isKillSwitchOff(current, { ...form, isEnabled: false })).toBe(true);
  });

  it('no marca como apagado lo que ya estaba apagado', () => {
    const current = config({ flags: { ...defaultOperationsSettings().flags, logistics: false } });
    const form = toSettingsForm(current);
    expect(flagsBeingDisabled(current, form)).toEqual([]);
  });

  it('describe la escalera en español', () => {
    expect(describeEscalation([0, 120], ['backup', 'area_lead'])).toBe(
      'al vencer → Suplente · 120 min después → Líder del área'
    );
    expect(describeEscalation([], [])).toContain('Sin escalera');
  });
});
