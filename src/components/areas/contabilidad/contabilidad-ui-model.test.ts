import { describe, expect, it } from 'vitest';
import { FINANCE_COMMANDS } from '@/modules/finance/types';
import {
  allocationIssues,
  canReverseEntry,
  captureExpenseCommand,
  cashCounts,
  countTone,
  createEmployeeCommand,
  createPayrollRunCommand,
  definedFields,
  expenseSubmitIssues,
  matchPaymentCommand,
  nextExpenseStep,
  nextPayrollStep,
  normalizeCatalogKey,
  payPayrollLineCommand,
  postExpenseCommand,
  proposalFields,
  proposalStatus,
  reopenReasonIssue,
  reverseBlockedReason,
  reverseEntryCommand,
  requestPaymentAuthorizationCommand,
  resolveExpenseDuplicateCommand,
  setBudgetCommand,
  settleObligationCommand,
  rescheduleIssues,
  rescheduleObligationCommand,
  settlementIssues,
  submitExpenseCommand,
  updateEmployeeCommand,
  updateExpenseCommand,
  writeOffObligationCommand,
  dailyCloseCommand,
  reopenPeriodCommand,
} from './contabilidad-ui-model';

const draft = {
  status: 'draft',
  duplicateStatus: 'none',
  amount: '1200.00',
  categoryId: 'cat-1',
  isPaid: true,
  cashAccountId: 'acc-1',
  receiptObjectIds: ['obj-1'],
};

describe('contabilidad-ui-model: comandos de gastos', () => {
  it('capturar manda el comando con agregado nuevo y sin campos vacíos', () => {
    const command = captureExpenseCommand({
      captureMode: 'text',
      rawInput: '  gasolina 800  ',
      amount: null,
      supplierNameFree: '',
      categoryId: 'cat-1',
    });
    expect(command.type).toBe(FINANCE_COMMANDS.expenseCapture);
    expect(command.aggregate).toStrictEqual({ type: 'expense', id: 'new' });
    expect(command.payload).toStrictEqual({
      captureMode: 'text',
      rawInput: 'gasolina 800',
      categoryId: 'cat-1',
    });
    expect(command.expectedVersion).toBeUndefined();
  });

  it('actualizar, resolver duplicado, enviar y contabilizar viajan con su versión', () => {
    expect(updateExpenseCommand('gx-1', 3, { amount: '950', description: '' })).toStrictEqual({
      type: FINANCE_COMMANDS.expenseUpdate,
      aggregate: { type: 'expense', id: 'gx-1' },
      payload: { expenseId: 'gx-1', amount: '950' },
      expectedVersion: 3,
    });
    expect(resolveExpenseDuplicateCommand('gx-1', 4, 'duplicate', 'gx-0').payload).toStrictEqual({
      expenseId: 'gx-1',
      decision: 'duplicate',
      duplicateOfId: 'gx-0',
    });
    expect(submitExpenseCommand('gx-1', 5)).toStrictEqual({
      type: FINANCE_COMMANDS.expenseSubmit,
      aggregate: { type: 'expense', id: 'gx-1' },
      payload: { expenseId: 'gx-1' },
      expectedVersion: 5,
    });
    expect(
      postExpenseCommand('gx-1', 6, { cashAccountId: 'acc-1', date: null }).payload
    ).toStrictEqual({ expenseId: 'gx-1', cashAccountId: 'acc-1' });
  });

  it('definedFields quita vacíos, nulos y espacios', () => {
    expect(definedFields({ a: ' x ', b: '', c: null, d: undefined, e: 0, f: false })).toStrictEqual(
      {
        a: 'x',
        e: 0,
        f: false,
      }
    );
  });
});

describe('contabilidad-ui-model: siguiente acción de un gasto', () => {
  it('lo completo se envía', () => {
    expect(nextExpenseStep(draft).key).toBe('submit');
  });

  it('un duplicado sospechoso se resuelve antes que nada', () => {
    expect(nextExpenseStep({ ...draft, duplicateStatus: 'suspect' }).key).toBe('resolve_duplicate');
  });

  it('pide importe, categoría, cuenta y comprobante en ese orden', () => {
    expect(nextExpenseStep({ ...draft, amount: '0' }).key).toBe('amount');
    expect(nextExpenseStep({ ...draft, categoryId: null }).key).toBe('category');
    expect(nextExpenseStep({ ...draft, cashAccountId: null }).key).toBe('cash_account');
    // Un gasto por pagar no necesita cuenta: al contabilizarlo abre la cuenta por pagar.
    expect(nextExpenseStep({ ...draft, cashAccountId: null, isPaid: false }).key).toBe('submit');
    expect(nextExpenseStep({ ...draft, receiptObjectIds: [] }).key).toBe('receipt');
  });

  it('sigue el estado cuando ya salió del borrador', () => {
    expect(nextExpenseStep({ ...draft, status: 'pending_approval' }).key).toBe('waiting_approval');
    expect(nextExpenseStep({ ...draft, status: 'approved' }).key).toBe('post');
    expect(nextExpenseStep({ ...draft, status: 'posted' }).key).toBe('done');
    expect(nextExpenseStep({ ...draft, status: 'rejected' }).key).toBe('done');
  });

  it('los bloqueos para enviar son los mismos que aplica el motor', () => {
    expect(expenseSubmitIssues(draft, '2026-09-15', '2026-09-14')).toStrictEqual([]);
    expect(expenseSubmitIssues({ ...draft, amount: '0' }, '2026-09-15', '2026-09-14')).toContain(
      'Falta el importe del gasto'
    );
    expect(expenseSubmitIssues(draft, '2026-09-15', '2026-09-30')).toContain(
      'La fecha del gasto no puede ser futura'
    );
    expect(
      expenseSubmitIssues({ ...draft, duplicateStatus: 'suspect' }, '2026-09-15', '2026-09-14')
    ).toContain('Resuelve primero si es un duplicado');
  });
});

describe('contabilidad-ui-model: propuesta de la IA', () => {
  it('lee los campos propuestos y los etiqueta en español', () => {
    const fields = proposalFields({
      status: 'ready',
      fields: { amount: '812.50', categoryName: 'Combustible', isPaid: true },
    });
    expect(fields.map((f) => f.label)).toStrictEqual(['Importe', 'Categoría', 'Pagado']);
    expect(fields[2].value).toBe('Sí');
  });

  it('ignora estructuras y dice cuándo sigue pensando', () => {
    expect(proposalStatus({ status: 'pending' })).toBe('pending');
    expect(proposalStatus(null)).toBe('none');
    expect(proposalStatus({ splits: [{ a: 1 }] })).toBe('none');
    expect(proposalStatus({ amount: '10' })).toBe('ready');
  });
});

describe('contabilidad-ui-model: obligaciones y cobros', () => {
  it('liquidar manda importe, cuenta y evidencia con la versión', () => {
    const command = settleObligationCommand({
      obligationId: 'ob-1',
      version: 2,
      amount: '500.00',
      cashAccountId: 'acc-1',
      date: null,
      memo: ' pago parcial ',
      evidenceObjectIds: ['obj-1'],
    });
    expect(command.type).toBe(FINANCE_COMMANDS.obligationSettle);
    expect(command.expectedVersion).toBe(2);
    expect(command.payload).toStrictEqual({
      obligationId: 'ob-1',
      amount: '500.00',
      cashAccountId: 'acc-1',
      memo: 'pago parcial',
      evidenceObjectIds: ['obj-1'],
    });
  });

  it('castigar y pedir autorización nombran su obligación', () => {
    expect(writeOffObligationCommand('ob-1', 2, ' incobrable ').payload).toStrictEqual({
      obligationId: 'ob-1',
      reason: 'incobrable',
    });
    const auth = requestPaymentAuthorizationCommand('ob-1');
    expect(auth.type).toBe(FINANCE_COMMANDS.paymentAuthorizationRequest);
    expect(auth.expectedVersion).toBeUndefined();
    expect(auth.payload).toStrictEqual({ obligationId: 'ob-1' });
  });

  it('avisa antes de liquidar de más, sin cuenta o sin autorización', () => {
    const base = {
      amount: '100',
      remaining: '500',
      cashAccountId: 'acc-1',
      currency: 'MXN',
      accountCurrency: 'MXN',
      canSettle: true,
    };
    expect(settlementIssues(base)).toStrictEqual([]);
    expect(settlementIssues({ ...base, amount: '600' })[0]).toContain('no puede pasar de');
    expect(settlementIssues({ ...base, amount: '0' })[0]).toContain('mayor a cero');
    expect(settlementIssues({ ...base, cashAccountId: null })).toContain(
      'Elige la cuenta de donde sale o entra el dinero'
    );
    expect(settlementIssues({ ...base, accountCurrency: 'USD' })[0]).toContain('USD');
    expect(settlementIssues({ ...base, canSettle: false })).toContain(
      'Falta la autorización del pago'
    );
  });

  it('reprogramar viaja con la nueva fecha, el motivo y la versión', () => {
    const command = rescheduleObligationCommand({
      obligationId: 'ob-1',
      version: 3,
      dueAt: '2026-10-15',
      reason: '  Renegociado con el proveedor  ',
    });
    expect(command.type).toBe(FINANCE_COMMANDS.obligationReschedule);
    expect(command.aggregate).toStrictEqual({ type: 'obligation', id: 'ob-1' });
    expect(command.expectedVersion).toBe(3);
    expect(command.payload).toStrictEqual({
      obligationId: 'ob-1',
      dueAt: '2026-10-15',
      reason: 'Renegociado con el proveedor',
    });
  });

  it('avisa antes de reprogramar con una fecha imposible, igual o sin motivo', () => {
    const base = { dueAt: '2026-10-15', currentDueAt: '2026-09-20', reason: 'Renegociado' };
    expect(rescheduleIssues(base)).toStrictEqual([]);
    expect(rescheduleIssues({ ...base, dueAt: '' })).toContain(
      'Elige la nueva fecha de vencimiento'
    );
    expect(rescheduleIssues({ ...base, dueAt: '15/10/2026' })).toContain(
      'Elige la nueva fecha de vencimiento'
    );
    expect(rescheduleIssues({ ...base, dueAt: '2026-09-20' })).toContain(
      'La nueva fecha es la misma que ya tenía'
    );
    expect(rescheduleIssues({ ...base, reason: 'x' })).toContain(
      'Escribe el motivo (mínimo 3 caracteres)'
    );
    // Una obligación sin fecha previa sí se puede fechar.
    expect(rescheduleIssues({ ...base, currentDueAt: null })).toStrictEqual([]);
  });

  it('asignar un cobro reparte sin pasarse del remanente', () => {
    const command = matchPaymentCommand('pay-1', [{ obligationId: 'ob-1', amount: '100' }]);
    expect(command.aggregate).toStrictEqual({ type: 'customer_payment', id: 'pay-1' });
    expect(allocationIssues('500', [{ obligationId: 'ob-1', amount: '100' }])).toStrictEqual([]);
    expect(allocationIssues('500', [])).toStrictEqual(['Asigna al menos una cuenta por cobrar']);
    expect(allocationIssues('100', [{ obligationId: 'ob-1', amount: '150' }])[0]).toContain(
      'más de lo que quedó'
    );
  });
});

describe('contabilidad-ui-model: libro y presupuesto', () => {
  it('sólo se reversa un asiento manual y no reversado', () => {
    expect(
      canReverseEntry({ sourceType: 'manual', reversedByEntryId: null, reversesEntryId: null })
    ).toBe(true);
    expect(
      canReverseEntry({ sourceType: null, reversedByEntryId: null, reversesEntryId: null })
    ).toBe(true);
    expect(
      canReverseEntry({ sourceType: 'expense', reversedByEntryId: null, reversesEntryId: null })
    ).toBe(false);
    expect(
      canReverseEntry({ sourceType: 'manual', reversedByEntryId: 'as-2', reversesEntryId: null })
    ).toBe(false);
    expect(reverseBlockedReason('obligation')).toContain('obligación');
    expect(reverseBlockedReason('payroll_run')).toContain('nómina');
  });

  it('el reverso lleva motivo y el presupuesto compone su llave', () => {
    expect(reverseEntryCommand('as-1', ' error de captura ').payload).toStrictEqual({
      entryId: 'as-1',
      reason: 'error de captura',
    });
    const budget = setBudgetCommand({
      periodKey: '2026-09',
      costCenterId: '',
      categoryId: 'cat-1',
      amount: '10000',
    });
    expect(budget.aggregate).toStrictEqual({ type: 'budget', id: '2026-09::cat-1' });
    expect(budget.payload).toStrictEqual({
      periodKey: '2026-09',
      costCenterId: '',
      categoryId: 'cat-1',
      amount: '10000',
    });
  });
});

describe('contabilidad-ui-model: cierre', () => {
  it('el arqueo sólo manda las cajas que alguien contó', () => {
    expect(cashCounts({ 'acc-1': ' 980.50 ', 'acc-2': '', 'acc-3': 'x' })).toStrictEqual([
      { cashAccountId: 'acc-1', counted: '980.50' },
    ]);
  });

  it('cerrar el día y reabrir llevan su llave compuesta', () => {
    expect(dailyCloseCommand('2026-09-14', [{ cashAccountId: 'a', counted: '10' }])).toStrictEqual({
      type: FINANCE_COMMANDS.closeDaily,
      aggregate: { type: 'period_close', id: 'daily:2026-09-14' },
      payload: { date: '2026-09-14', counts: [{ cashAccountId: 'a', counted: '10' }] },
    });
    expect(
      reopenPeriodCommand('monthly', '2026-08', ' se registró un gasto tarde ').payload
    ).toStrictEqual({
      kind: 'monthly',
      periodKey: '2026-08',
      reason: 'se registró un gasto tarde',
    });
  });

  it('el motivo de reapertura pide al menos diez caracteres', () => {
    expect(reopenReasonIssue('corto')).toContain('al menos 10');
    expect(reopenReasonIssue('se registró un gasto tarde')).toBeNull();
    expect(reopenReasonIssue('x'.repeat(1001))).toContain('1000');
  });

  it('el tono del arqueo señala la diferencia', () => {
    expect(countTone('1000.00', '1000.00')).toBe('success');
    expect(countTone('1000.00', '990.00')).toBe('warning');
    expect(countTone('1000.00', '500.00')).toBe('danger');
    expect(countTone('1000.00', '')).toBe('default');
  });
});

describe('contabilidad-ui-model: nómina y catálogos', () => {
  it('la corrida se crea con sus líneas y se paga por empleado', () => {
    const run = createPayrollRunCommand({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      lines: [{ employeeId: 'emp-1', gross: '5000', costCenterId: null }],
    });
    expect(run.type).toBe(FINANCE_COMMANDS.payrollCreate);
    expect(run.payload).toStrictEqual({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      lines: [{ employeeId: 'emp-1', gross: '5000' }],
    });
    expect(
      payPayrollLineCommand('nom-1', 2, { employeeId: 'emp-1', cashAccountId: 'acc-1' })
    ).toStrictEqual({
      type: FINANCE_COMMANDS.payrollPayLine,
      aggregate: { type: 'payroll_run', id: 'nom-1' },
      payload: { payrollRunId: 'nom-1', employeeId: 'emp-1', cashAccountId: 'acc-1' },
      expectedVersion: 2,
    });
  });

  it('el siguiente paso de una corrida sigue su estado', () => {
    expect(nextPayrollStep('draft').key).toBe('submit');
    expect(nextPayrollStep('pending_approval').key).toBe('edit');
    expect(nextPayrollStep('approved').key).toBe('obligations');
    expect(nextPayrollStep('obligations_created').key).toBe('pay');
    expect(nextPayrollStep('paid').key).toBe('close');
    expect(nextPayrollStep('closed').key).toBe('done');
  });

  it('las llaves de catálogo se normalizan y el empleado nace nuevo', () => {
    expect(normalizeCatalogKey('  Caja Chica Obra Norte ')).toBe('caja_chica_obra_norte');
    expect(normalizeCatalogKey('Nómina/Sueldos')).toBe('nomina_sueldos');
    expect(createEmployeeCommand({ name: ' Ana ' }).payload).toStrictEqual({ name: 'Ana' });
  });

  /**
   * Plan 6.0: «Employee {name, position, userId?, areaKey?, active}… no todo
   * empleado tiene login». El servicio siempre aceptó `userId` y `areaKey`,
   * pero la pantalla no los mandaba, así que eran columnas muertas.
   */
  it('el alta liga la cuenta y el área del empleado, y sin cuenta no manda el campo', () => {
    expect(
      createEmployeeCommand({
        name: 'Ana',
        position: 'Compradora',
        userId: 'usr_1',
        areaKey: 'compras',
        costCenterId: 'cc_1',
      }).payload
    ).toStrictEqual({
      name: 'Ana',
      position: 'Compradora',
      userId: 'usr_1',
      areaKey: 'compras',
      costCenterId: 'cc_1',
    });
    // Un empleado sin acceso al sistema: el campo NO viaja (no es lo mismo que vacío).
    expect(
      createEmployeeCommand({ name: 'Ana', userId: null, areaKey: null }).payload
    ).toStrictEqual({
      name: 'Ana',
    });
  });

  it('la edición distingue desligar la cuenta de no tocarla', () => {
    expect(updateEmployeeCommand('emp-1', { userId: 'usr_2', areaKey: 'ventas' })).toStrictEqual({
      type: FINANCE_COMMANDS.employeeUpdate,
      aggregate: { type: 'employee', id: 'emp-1' },
      payload: { employeeId: 'emp-1', userId: 'usr_2', areaKey: 'ventas' },
    });
    // `null` viaja: el servicio lo lee como «déjalo vacío».
    expect(updateEmployeeCommand('emp-1', { userId: null, areaKey: null }).payload).toStrictEqual({
      employeeId: 'emp-1',
      userId: null,
      areaKey: null,
    });
    // Dar de baja no toca la cuenta ni el área.
    expect(updateEmployeeCommand('emp-1', { active: false }).payload).toStrictEqual({
      employeeId: 'emp-1',
      active: false,
    });
  });
});
