import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Internal accounting permissions (code-first registry, no migration).
 *
 * - `finance.view`: cash book, entries, obligations with aging, expenses,
 *   payroll, budgets, closes and the `finance:board` realtime channel.
 * - `finance.capture_expense`: capture expenses (form, text, voice, photo,
 *   templates), edit own drafts, resolve their duplicates and submit them.
 * - `finance.approve`: approver of the `expense`, `payment` and `payroll`
 *   business approval scopes (registered with approvals-service).
 * - `finance.post`: post approved expenses and manual entries, and correct
 *   by reversal (entries, settlements, posted expenses).
 * - `finance.manage_obligations`: create, settle, cancel and write off
 *   payables/receivables, request payment authorizations and assign
 *   collections to expected receivables.
 * - `finance.payroll`: employee directory, payroll runs, advances and payroll
 *   payments.
 * - `finance.close`: daily and monthly closes and reopening a closed period.
 * - `finance.manage_catalog`: cash accounts, categories, cost centers,
 *   budgets, shared expense templates and the finance settings.
 * - `finance.export`: export ledger lines and reports.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const FINANCE_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'finance.view',
    group: 'Contabilidad',
    label: 'Ver contabilidad interna',
    description:
      'Permite consultar libro de caja, asientos, obligaciones, gastos, nómina, presupuestos y cierres',
  },
  {
    key: 'finance.capture_expense',
    group: 'Contabilidad',
    label: 'Capturar gastos',
    description:
      'Permite capturar gastos por formulario, texto, voz o foto, editar sus borradores y enviarlos a aprobación',
  },
  {
    key: 'finance.approve',
    group: 'Contabilidad',
    label: 'Aprobar gastos, pagos y nómina',
    description: 'Permite firmar las aprobaciones de negocio de gastos, pagos y nómina',
  },
  {
    key: 'finance.post',
    group: 'Contabilidad',
    label: 'Contabilizar y reversar',
    description:
      'Permite contabilizar gastos aprobados y asientos manuales, y corregir con asientos de reverso',
  },
  {
    key: 'finance.manage_obligations',
    group: 'Contabilidad',
    label: 'Gestionar cuentas por pagar y cobrar',
    description:
      'Permite crear, liquidar, cancelar y castigar obligaciones, pedir autorizaciones de pago y asignar cobros',
  },
  {
    key: 'finance.payroll',
    group: 'Contabilidad',
    label: 'Gestionar nómina',
    description:
      'Permite administrar el directorio de empleados, las corridas de nómina, anticipos y pagos de nómina',
  },
  {
    key: 'finance.close',
    group: 'Contabilidad',
    label: 'Cerrar periodos',
    description: 'Permite ejecutar cierres diarios y mensuales y reabrir un periodo con motivo',
  },
  {
    key: 'finance.manage_catalog',
    group: 'Contabilidad',
    label: 'Administrar catálogo contable',
    description:
      'Permite administrar cuentas de caja y banco, categorías, centros de costo, presupuestos y plantillas compartidas',
  },
  {
    key: 'finance.export',
    group: 'Contabilidad',
    label: 'Exportar contabilidad',
    description: 'Permite exportar renglones del libro y reportes de contabilidad interna',
  },
];

/** Every finance permission key (stable order). */
export const FINANCE_PERMISSION_KEYS = FINANCE_PERMISSIONS.map((p) => p.key);

/**
 * Action keys a person of Contabilidad acts with (plan 5.8 / 7.2): the
 * candidates for `AREA_ACT_PERMISSION_CANDIDATES.contabilidad`.
 */
export const FINANCE_AREA_ACT_PERMISSIONS = [
  'finance.capture_expense',
  'finance.post',
  'finance.manage_obligations',
  'finance.payroll',
  'finance.close',
] as const;

/**
 * Keys the Contabilidad AI identity may hold (read + drafting actions only:
 * never approve, post, close, payroll, catalog or export).
 */
export const FINANCE_AGENT_PERMISSIONS = {
  read: ['finance.view'],
  act: ['finance.capture_expense', 'finance.manage_obligations'],
} as const;
