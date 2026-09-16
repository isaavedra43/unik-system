import { describe, expect, it } from 'vitest';
import { AREA_REGISTRY } from '@/modules/areas/area-registry';
import { parseBranchActions } from '@/modules/areas/work-actions';
import { AGING_BUCKETS, AGING_BUCKET_LABELS } from '@/modules/finance/obligation-rules';
import { FINANCE_PERMISSION_KEYS } from '@/modules/finance/permissions';
import { FINANCE_COMMANDS } from '@/modules/finance/types';
import {
  AGING_BUCKETS_UI,
  CONTABILIDAD_ROW_KINDS,
  CONTABILIDAD_SECTIONS,
  EXPENSE_ROW_ACTIONS,
  OBLIGATION_AUTHORIZATION_ACTIONS,
  OBLIGATION_CANCEL_ACTIONS,
  addDaysToDateKey,
  agingBucketLabel,
  budgetTone,
  budgetUsedPercent,
  canSettleNow,
  closeRowTitle,
  contabilidadFocusHref,
  countDifference,
  dateKeyOfInstant,
  expenseStatusTone,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  needsCashCount,
  obligationStatusTone,
  parseCloseChecks,
  periodKeyOf,
  periodRange,
  summarizeCloseChecks,
  describeCloseProgress,
  visibleContabilidadSections,
  whereItIsAttended,
} from './contabilidad-model';

const holder = (keys: string[], isSuperAdmin = false) => ({
  permissionKeys: keys,
  isSuperAdmin,
});

describe('contabilidad-model: contratos con el registro y con finanzas', () => {
  it('declara exactamente los tipos de fila del área', () => {
    const declared = AREA_REGISTRY.contabilidad.workCenter.rowKinds;
    for (const kind of CONTABILIDAD_ROW_KINDS) {
      expect(declared, kind).toContain(kind);
    }
  });

  it('las secciones sólo piden permisos reales de contabilidad', () => {
    const known = new Set([...FINANCE_PERMISSION_KEYS, 'operations.admin']);
    for (const section of CONTABILIDAD_SECTIONS) {
      expect(section.anyOf.length, section.id).toBeGreaterThan(0);
      for (const key of section.anyOf) expect(known.has(key), `${section.id}: ${key}`).toBe(true);
      expect(section.href.startsWith('/app/areas/contabilidad/'), section.id).toBe(true);
    }
  });

  it('los buckets de antigüedad no se separan de los del módulo de finanzas', () => {
    expect([...AGING_BUCKETS_UI]).toStrictEqual([...AGING_BUCKETS]);
    for (const bucket of AGING_BUCKETS) {
      expect(agingBucketLabel(bucket), bucket).toBe(AGING_BUCKET_LABELS[bucket]);
    }
  });
});

describe('contabilidad-model: permisos y enlaces', () => {
  it('muestra sólo las secciones que la persona puede abrir', () => {
    const ids = visibleContabilidadSections(holder(['finance.capture_expense'])).map((s) => s.id);
    expect(ids).toStrictEqual(['gastos', 'gastos-nuevo']);
  });

  it('operations.admin abre todas las secciones y un super admin también', () => {
    expect(visibleContabilidadSections(holder(['operations.admin'])).length).toBe(
      CONTABILIDAD_SECTIONS.length
    );
    expect(visibleContabilidadSections(holder([], true)).length).toBe(CONTABILIDAD_SECTIONS.length);
  });

  it('sin permisos de contabilidad no ofrece ninguna sección', () => {
    expect(visibleContabilidadSections(holder(['crm.view']))).toStrictEqual([]);
  });

  it('cada tipo de fila enlaza a donde se atiende y lo explica', () => {
    expect(contabilidadFocusHref('expense', 'gx-1')).toBe(
      '/app/areas/contabilidad/gastos/nuevo?gasto=gx-1'
    );
    expect(contabilidadFocusHref('obligation', 'ob 1')).toBe(
      '/app/areas/contabilidad/obligaciones?obligacion=ob%201'
    );
    expect(contabilidadFocusHref('period_close_task', 'pc-1')).toBe(
      '/app/areas/contabilidad/cierre'
    );
    expect(contabilidadFocusHref('work_item', 'wi-1')).toBeNull();
    expect(whereItIsAttended('obligation')).toContain('Obligaciones');
  });
});

describe('contabilidad-model: tonos de estado', () => {
  it('un gasto contabilizado es éxito y uno rechazado es débil', () => {
    expect(expenseStatusTone('posted')).toBe('success');
    expect(expenseStatusTone('rejected')).toBe('weak');
    expect(expenseStatusTone('draft')).toBe('warning');
    expect(expenseStatusTone('otro')).toBe('default');
  });

  it('una obligación liquidada es éxito y una castigada es débil', () => {
    expect(obligationStatusTone('settled')).toBe('success');
    expect(obligationStatusTone('written_off')).toBe('weak');
    expect(obligationStatusTone('partially_settled')).toBe('info');
  });
});

describe('contabilidad-model: liquidación y autorización', () => {
  it('una cuenta por cobrar abierta se puede liquidar sin autorización', () => {
    expect(
      canSettleNow({ status: 'expected', kind: 'receivable', paymentAuthorization: 'missing' })
    ).toBe(true);
  });

  it('una cuenta por pagar sin autorización no se puede liquidar', () => {
    expect(
      canSettleNow({ status: 'expected', kind: 'payable', paymentAuthorization: 'missing' })
    ).toBe(false);
    expect(
      canSettleNow({ status: 'expected', kind: 'payable', paymentAuthorization: 'pending' })
    ).toBe(false);
    expect(
      canSettleNow({ status: 'expected', kind: 'payable', paymentAuthorization: 'approved' })
    ).toBe(true);
    expect(
      canSettleNow({
        status: 'partially_settled',
        kind: 'payable',
        paymentAuthorization: 'not_required',
      })
    ).toBe(true);
  });

  it('una obligación cerrada nunca se liquida', () => {
    expect(
      canSettleNow({ status: 'settled', kind: 'payable', paymentAuthorization: 'approved' })
    ).toBe(false);
  });
});

describe('contabilidad-model: formato', () => {
  it('da guion cuando no hay número', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('no es número')).toBe('—');
    expect(formatPercent(null)).toBe('—');
    expect(formatMoneyCompact(undefined)).toBe('—');
  });

  it('abrevia importes grandes y respeta los chicos', () => {
    expect(formatMoneyCompact(1_450_000)).toBe('$1.5 M');
    expect(formatMoneyCompact(845_300)).toBe('$845.3 k');
    expect(formatMoneyCompact(-1_200_000)).toBe('-$1.2 M');
    expect(formatMoneyCompact(980)).toContain('980');
  });

  it('formatea porcentajes sin decimales por omisión', () => {
    expect(formatPercent(83.4)).toBe('83 %');
    expect(formatPercent(83.45, 1)).toBe('83.5 %');
  });

  it('calcula claves de fecha y periodo estables', () => {
    expect(dateKeyOfInstant(new Date('2026-09-15T18:00:00.000Z'))).toBe('2026-09-15');
    expect(periodKeyOf('2026-09-15')).toBe('2026-09');
    expect(addDaysToDateKey('2026-09-28', 7)).toBe('2026-10-05');
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(periodRange('2026-02')).toStrictEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('2026-09')).toStrictEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('contabilidad-model: presupuesto y arqueo', () => {
  it('consumo del presupuesto y su tono', () => {
    expect(budgetUsedPercent('500', '1000')).toBe(50);
    expect(budgetUsedPercent('1200', '1000')).toBe(120);
    expect(budgetUsedPercent('100', '0')).toBeNull();
    expect(budgetUsedPercent(null, '1000')).toBeNull();
    expect(budgetTone(50)).toBe('success');
    expect(budgetTone(90)).toBe('warning');
    expect(budgetTone(120)).toBe('danger');
    expect(budgetTone(null)).toBe('default');
  });

  it('la diferencia de arqueo es contado menos libro', () => {
    expect(countDifference('1000.00', '980.50')).toBe(-19.5);
    expect(countDifference('1000', '1000')).toBe(0);
    expect(countDifference('1000', null)).toBeNull();
    expect(needsCashCount('cash')).toBe(true);
    expect(needsCashCount('petty_cash')).toBe(true);
    expect(needsCashCount('bank')).toBe(false);
  });
});

describe('contabilidad-model: checklist del cierre', () => {
  const checks = [
    {
      key: 'pending_expenses',
      label: 'Gastos pendientes',
      ok: false,
      blocking: true,
      detail: 'GX-1 y GX-2',
    },
    { key: 'unassigned', label: 'Cobros sin asignar', ok: true, blocking: true, detail: 'Ninguno' },
    { key: 'previous', label: 'Mes anterior', ok: false, blocking: false, detail: 'Sigue abierto' },
  ];

  it('lee los checks del JSON y descarta lo que no lo es', () => {
    expect(parseCloseChecks(checks)).toHaveLength(3);
    expect(parseCloseChecks(null)).toStrictEqual([]);
    expect(parseCloseChecks([{ label: 'sin llave' }, 'texto', 42])).toStrictEqual([]);
    expect(parseCloseChecks([{ key: 'k' }])[0]).toStrictEqual({
      key: 'k',
      label: 'k',
      ok: false,
      blocking: false,
      detail: '',
    });
  });

  it('separa bloqueos de advertencias y calcula el avance', () => {
    const progress = summarizeCloseChecks(parseCloseChecks(checks));
    expect(progress.total).toBe(3);
    expect(progress.ok).toBe(1);
    expect(progress.percent).toBe(33);
    expect(progress.blockers.map((b) => b.key)).toStrictEqual(['pending_expenses']);
    expect(progress.warnings.map((b) => b.key)).toStrictEqual(['previous']);
    expect(describeCloseProgress(progress)).toBe('1 bloqueo: Gastos pendientes.');
  });

  it('sin intentos no inventa avance', () => {
    const progress = summarizeCloseChecks([]);
    expect(progress.percent).toBeNull();
    expect(describeCloseProgress(progress)).toBe(
      'Todavía no se intenta el cierre de este periodo.'
    );
  });

  it('sin bloqueos lo dice con todas sus letras', () => {
    const clean = summarizeCloseChecks([
      { key: 'a', label: 'A', ok: true, blocking: true, detail: '' },
      { key: 'b', label: 'B', ok: false, blocking: false, detail: '' },
    ]);
    expect(describeCloseProgress(clean)).toBe('Sin bloqueos; 1 advertencia por revisar.');
    expect(
      describeCloseProgress(
        summarizeCloseChecks([{ key: 'a', label: 'A', ok: true, blocking: true, detail: '' }])
      )
    ).toBe('Sin bloqueos: el periodo puede cerrarse.');
  });

  it('titula la fila de cierre en español', () => {
    expect(closeRowTitle('monthly', '2026-08')).toBe('Cierre mensual 2026-08');
    expect(closeRowTitle('daily', '2026-09-14')).toBe('Cierre diario 2026-09-14');
  });
});

describe('contabilidad-model: acciones de las filas del centro de trabajo', () => {
  const ALL_ACTIONS = [
    ...Object.values(EXPENSE_ROW_ACTIONS).flat(),
    ...OBLIGATION_CANCEL_ACTIONS,
    ...OBLIGATION_AUTHORIZATION_ACTIONS,
  ];

  it('cada acción ejecuta un comando de finanzas que existe', () => {
    const known = new Set(Object.values(FINANCE_COMMANDS));
    for (const action of ALL_ACTIONS) {
      expect(known.has(action.commandType as never), action.id).toBe(true);
    }
  });

  it('cada acción pide un permiso real de contabilidad', () => {
    const known = new Set(FINANCE_PERMISSION_KEYS);
    for (const action of ALL_ACTIONS) {
      expect(action.permissions.length, action.id).toBeGreaterThan(0);
      for (const key of action.permissions)
        expect(known.has(key), `${action.id}: ${key}`).toBe(true);
    }
  });

  it('un gasto ofrece enviar y descartar en borrador, y contabilizar ya aprobado', () => {
    expect(EXPENSE_ROW_ACTIONS.draft.map((action) => action.commandType)).toStrictEqual([
      FINANCE_COMMANDS.expenseSubmit,
      FINANCE_COMMANDS.expenseReject,
    ]);
    expect(EXPENSE_ROW_ACTIONS.approved.map((action) => action.commandType)).toStrictEqual([
      FINANCE_COMMANDS.expensePost,
      FINANCE_COMMANDS.expenseReject,
    ]);
    // Una aprobación pendiente se firma en Mi trabajo, no en la tabla del área.
    expect(EXPENSE_ROW_ACTIONS.pending_approval).toBeUndefined();
  });

  it('sobreviven la validación del marco con el id que agrega la rama SQL', () => {
    const fromSql = EXPENSE_ROW_ACTIONS.draft.map((action) => ({
      ...action,
      payload: { expenseId: 'gx-1' },
    }));
    const parsed = parseBranchActions(fromSql);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].commandType).toBe(FINANCE_COMMANDS.expenseSubmit);
    expect(parsed[0].payload).toStrictEqual({ expenseId: 'gx-1' });
    expect(parsed[0].permissions).toStrictEqual(['finance.capture_expense']);

    const obligation = parseBranchActions(
      OBLIGATION_CANCEL_ACTIONS.map((action) => ({ ...action, payload: { obligationId: 'ob-1' } }))
    );
    expect(obligation[0].form).toBe('reason');
    expect(obligation[0].payload).toStrictEqual({ obligationId: 'ob-1' });
  });

  it('el motivo y la confirmación viajan en español', () => {
    for (const action of ALL_ACTIONS) {
      expect(action.successMessage.length, action.id).toBeGreaterThan(0);
      if (action.tone === 'danger') expect(action.confirm, action.id).toBeTruthy();
    }
  });
});
