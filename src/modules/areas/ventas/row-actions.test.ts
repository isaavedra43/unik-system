import { describe, expect, it } from 'vitest';
import { buildActionPayload, buildRowCommand } from '@/components/areas/area-workspace-model';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { getRowActions, noActionsReason, parseBranchActions } from '@/modules/areas/work-actions';
import { AREA_WORK_ROW_COLUMNS, type AreaWorkSqlFilters } from '@/modules/areas/work-rows-sql';
import { CRM_COMMANDS } from '@/modules/crm/types';
import { ventasWorkRowBranches } from './work-branches';
import {
  CASE_ROW_ACTIONS,
  OPPORTUNITY_ROW_ACTIONS,
  QUOTE_ACTIONS_NOTE,
  unknownVentasActionStatuses,
  ventasActionsForStatus,
  ventasRowActions,
  type VentasBranchAction,
} from './row-actions';

/**
 * Ventas era la única área cuyas filas de dominio (expediente, oportunidad y
 * cotización) llegaban al centro de trabajo SIN acciones: `getRowActions` leía
 * `extra.actions`, la rama nunca lo escribía y el menú salía vacío con el texto
 * genérico, aunque los comandos `crm.opportunity.*` existieran desde la fase 6.
 *
 * Estas pruebas exigen que el catálogo nombre comandos y estados REALES, que la
 * rama SQL lo lleve como parámetro ligado, y que lo que sale por `getRowActions`
 * sea exactamente el comando que el motor espera (agregado, payload, llave del
 * texto y versión optimista).
 */

const CRM_COMMAND_SET = new Set<string>(Object.values(CRM_COMMANDS));
/** Los del núcleo: `CASE_COMMANDS` vive en un módulo que importa Prisma. */
const CASE_COMMAND_SET = new Set<string>(['case.advance', 'case.cancel']);
const NOW = new Date('2026-09-15T18:00:00.000Z');

function filters(overrides: Partial<AreaWorkSqlFilters> = {}): AreaWorkSqlFilters {
  return { areaKey: 'ventas', scope: 'open', now: NOW, ...overrides };
}

function branch(rowKind: string) {
  const found = ventasWorkRowBranches().find((entry) => entry.rowKind === rowKind);
  if (!found) throw new Error(`Falta la rama ${rowKind}`);
  return found;
}

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: 'opportunity:opp-1',
    rowKind: 'opportunity',
    sourceId: 'opp-1',
    areaKey: 'ventas',
    caseId: null,
    caseNumber: null,
    customerName: 'Aceros del Norte',
    title: 'Rejilla para nave 3',
    status: 'open',
    statusLabel: 'Abierta',
    statusTone: 'info',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-1',
    ownerName: 'Ana',
    dueAt: null,
    startedAt: null,
    lastActivityAt: NOW.toISOString(),
    escalationLevel: 0,
    waitReason: null,
    objectType: 'opportunity',
    objectId: 'opp-1',
    counterpartyName: 'Propuesta',
    locationCode: null,
    amount: '120000',
    quantity: null,
    version: 4,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

/** La misma forma que arma la rama SQL: entrada del catálogo + payload por fila. */
function withPayload(actions: readonly VentasBranchAction[], payload: Record<string, unknown>) {
  return actions.map((action) => ({
    ...action,
    payload: { ...(action.payload ?? {}), ...payload },
  }));
}

const seller = { id: 'u-2', permissionKeys: ['crm.manage'], isSuperAdmin: false };
const reader = { id: 'u-3', permissionKeys: ['crm.view'], isSuperAdmin: false };
const operator = { id: 'u-4', permissionKeys: ['operations.manage'], isSuperAdmin: false };

describe('catálogo de acciones de Ventas', () => {
  it('sólo nombra comandos reales y siempre pide un permiso', () => {
    for (const action of OPPORTUNITY_ROW_ACTIONS) {
      expect(CRM_COMMAND_SET.has(action.commandType), action.id).toBe(true);
      expect(action.permissions, action.id).toStrictEqual(['crm.manage']);
    }
    for (const action of CASE_ROW_ACTIONS) {
      expect(CASE_COMMAND_SET.has(action.commandType), action.id).toBe(true);
      expect(action.permissions, action.id).toStrictEqual([
        'operations.manage',
        'operations.admin',
      ]);
    }
  });

  it('sólo nombra estados reales', () => {
    expect(unknownVentasActionStatuses()).toStrictEqual([]);
  });

  it('responde por clase de fila y no inventa comandos para la cotización', () => {
    expect(ventasRowActions('opportunity')).toBe(OPPORTUNITY_ROW_ACTIONS);
    expect(ventasRowActions('case')).toBe(CASE_ROW_ACTIONS);
    expect(ventasRowActions('quote')).toStrictEqual([]);
  });

  it('el estado decide qué acciones lleva la fila (lo mismo que filtra el SQL)', () => {
    expect(ventasActionsForStatus('opportunity', 'open').map((action) => action.id)).toStrictEqual([
      'opportunity.mark_won',
      'opportunity.mark_lost',
      'opportunity.mark_dormant',
      'opportunity.record_note',
    ]);
    // Una oportunidad dormida ya no se vuelve a dormir.
    expect(
      ventasActionsForStatus('opportunity', 'dormant').map((action) => action.id)
    ).toStrictEqual(['opportunity.mark_won', 'opportunity.mark_lost', 'opportunity.record_note']);
    expect(ventasActionsForStatus('opportunity', 'won')).toStrictEqual([]);
    expect(ventasActionsForStatus('opportunity', 'lost')).toStrictEqual([]);
    expect(ventasActionsForStatus('case', 'open').map((action) => action.id)).toStrictEqual([
      'case.advance',
      'case.cancel',
    ]);
    expect(ventasActionsForStatus('case', 'closed')).toStrictEqual([]);
    expect(ventasActionsForStatus('case', 'cancelled')).toStrictEqual([]);
  });

  it('las acciones cuyo comando no llama al texto `note`/`reason` declaran su llave', () => {
    const byId = new Map(OPPORTUNITY_ROW_ACTIONS.map((action) => [action.id, action]));
    expect(byId.get('opportunity.mark_lost')?.payloadTextKey).toBe('lostReason');
    expect(byId.get('opportunity.record_note')?.payloadTextKey).toBe('summary');
    expect(byId.get('opportunity.record_note')?.payload).toStrictEqual({ kind: 'note' });
    // Las que sí usan el nombre del formulario no declaran nada.
    expect(byId.get('opportunity.mark_won')?.payloadTextKey).toBeUndefined();
    expect(byId.get('opportunity.mark_dormant')?.payloadTextKey).toBeUndefined();
  });
});

describe('ramas SQL de Ventas', () => {
  it('cada rama sigue proyectando las columnas canónicas en el mismo orden', () => {
    for (const entry of ventasWorkRowBranches()) {
      const aliases = [
        ...entry.sql(filters({ scope: 'all' })).text.matchAll(/AS "([A-Za-z]+)"/g),
      ].map((match) => match[1]);
      expect(aliases, entry.rowKind).toStrictEqual([...AREA_WORK_ROW_COLUMNS]);
    }
  });

  it('las tres ramas escriben `actions`; la cotización además dice dónde se atiende', () => {
    for (const entry of ventasWorkRowBranches()) {
      expect(entry.sql(filters()).text, entry.rowKind).toContain(`'actions'`);
    }
    const quote = branch('quote').sql(filters());
    expect(quote.text).toContain(`'actionsNote'`);
    expect(quote.values).toContain(QUOTE_ACTIONS_NOTE);
  });

  it('el catálogo viaja como parámetro ligado, nunca en el texto de la sentencia', () => {
    for (const rowKind of ['case', 'opportunity']) {
      const sql = branch(rowKind).sql(filters());
      expect(sql.text, rowKind).not.toContain('commandType');
      const catalogs = sql.values.filter(
        (value): value is string => typeof value === 'string' && value.includes('"commandType"')
      );
      expect(catalogs, rowKind).toHaveLength(1);
      const parsed = JSON.parse(catalogs[0]) as VentasBranchAction[];
      expect(parsed.map((action) => action.id)).toStrictEqual(
        ventasRowActions(rowKind).map((action) => action.id)
      );
    }
  });

  it('el expediente no añade ningún id al payload (sus comandos son `.strict()`)', () => {
    const sql = branch('case').sql(filters()).text;
    expect(sql).toContain(`COALESCE(entry.value -> 'payload', '{}'::jsonb) || '{}'::jsonb`);
    const opportunity = branch('opportunity').sql(filters()).text;
    expect(opportunity).toContain(`jsonb_build_object('opportunityId', o."id")`);
  });

  it('un identificador escrito por una persona nunca se interpola', () => {
    const attack = 'u-1\'; DROP TABLE "Opportunity"; --';
    for (const entry of ventasWorkRowBranches()) {
      const sql = entry.sql(filters({ ownerUserId: attack, caseId: attack }));
      expect(sql.text, entry.rowKind).not.toContain('DROP TABLE');
    }
  });
});

describe('contrato con work-actions y con el motor', () => {
  it('ofrece al vendedor lo que puede hacer con una oportunidad abierta', () => {
    const actions = getRowActions(
      row({
        extra: {
          actions: withPayload(ventasActionsForStatus('opportunity', 'open'), {
            opportunityId: 'opp-1',
          }),
        },
      }),
      seller
    );
    expect(actions.map((action) => action.id)).toStrictEqual([
      'opportunity.mark_won',
      'opportunity.mark_lost',
      'opportunity.mark_dormant',
      'opportunity.record_note',
    ]);
    expect(actions[0].payload).toStrictEqual({ opportunityId: 'opp-1' });
  });

  it('no ofrece nada a quien sólo ve el CRM, ni siquiera con el permiso de actuar del área', () => {
    const actions = getRowActions(
      row({
        extra: {
          actions: withPayload(ventasActionsForStatus('opportunity', 'open'), {
            opportunityId: 'opp-1',
          }),
        },
      }),
      reader,
      { actPermissions: ['crm.manage'] }
    );
    expect(actions).toStrictEqual([]);
  });

  it('el vendedor no cancela expedientes y quien opera el núcleo no cierra ventas', () => {
    const caseRow = row({
      id: 'case:c-1',
      rowKind: 'case',
      sourceId: 'c-1',
      status: 'open',
      objectType: 'operational_case',
      objectId: 'c-1',
      version: 9,
      extra: { actions: withPayload(ventasActionsForStatus('case', 'open'), {}) },
    });
    expect(getRowActions(caseRow, seller)).toStrictEqual([]);
    const caseActions = getRowActions(caseRow, operator);
    expect(caseActions.map((action) => action.id)).toStrictEqual(['case.advance', 'case.cancel']);
    expect(
      buildRowCommand(caseActions[1], caseRow, { reason: 'El cliente canceló el pedido' })
    ).toStrictEqual({
      type: 'case.cancel',
      aggregate: { type: 'operational_case', id: 'c-1' },
      payload: { reason: 'El cliente canceló el pedido' },
      expectedVersion: 9,
    });

    // `operations.manage` opera el núcleo, así que sí ve las del expediente,
    // pero las del embudo siguen pidiendo `crm.manage`.
    const opportunityRow = row({
      extra: {
        actions: withPayload(ventasActionsForStatus('opportunity', 'open'), {
          opportunityId: 'opp-1',
        }),
      },
    });
    expect(getRowActions(opportunityRow, { ...operator, id: 'u-9' })).toStrictEqual([]);
  });

  it('«Marcar perdida» manda el motivo como `lostReason`, que es lo que exige el comando', () => {
    const lost = OPPORTUNITY_ROW_ACTIONS.find(
      (action) => action.id === 'opportunity.mark_lost'
    ) as VentasBranchAction;
    const [action] = parseBranchActions(withPayload([lost], { opportunityId: 'opp-1' }));
    expect(action.payloadTextKey).toBe('lostReason');
    const payload = buildActionPayload(action, { text: 'Compró con el competidor' }, NOW);
    expect(payload).toStrictEqual({
      ok: true,
      payload: { lostReason: 'Compró con el competidor' },
    });
    expect(payload.ok && buildRowCommand(action, row(), payload.payload)).toStrictEqual({
      type: CRM_COMMANDS.opportunityMarkLost,
      aggregate: { type: 'opportunity', id: 'opp-1' },
      payload: { opportunityId: 'opp-1', lostReason: 'Compró con el competidor' },
      expectedVersion: 4,
    });
  });

  it('«Registrar nota» conserva su `kind` fijo y manda el texto como `summary`', () => {
    const note = OPPORTUNITY_ROW_ACTIONS.find(
      (action) => action.id === 'opportunity.record_note'
    ) as VentasBranchAction;
    const [action] = parseBranchActions(withPayload([note], { opportunityId: 'opp-1' }));
    expect(action.payload).toStrictEqual({ kind: 'note', opportunityId: 'opp-1' });
    const payload = buildActionPayload(action, { text: 'Pidió revisar el flete' }, NOW);
    expect(payload.ok && payload.payload).toStrictEqual({ summary: 'Pidió revisar el flete' });
  });

  it('una acción que no declara llave sigue mandando `note` / `reason`', () => {
    const [won] = parseBranchActions(
      withPayload(
        OPPORTUNITY_ROW_ACTIONS.filter((action) => action.id === 'opportunity.mark_won'),
        { opportunityId: 'opp-1' }
      )
    );
    expect(buildActionPayload(won, { text: 'Firmó el anticipo' }, NOW)).toStrictEqual({
      ok: true,
      payload: { note: 'Firmó el anticipo' },
    });
  });

  it('la cotización explica dónde se convierte en vez de dejar el menú mudo', () => {
    const quote = row({
      id: 'quote:q-1',
      rowKind: 'quote',
      sourceId: 'q-1',
      status: 'accepted',
      statusLabel: 'Aceptada',
      objectType: 'quote',
      objectId: 'q-1',
      ownerUserId: null,
      extra: { actions: [], actionsNote: QUOTE_ACTIONS_NOTE },
    });
    expect(getRowActions(quote, seller)).toStrictEqual([]);
    expect(noActionsReason(quote, seller)).toBe(QUOTE_ACTIONS_NOTE);
  });
});
