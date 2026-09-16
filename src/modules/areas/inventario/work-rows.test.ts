import { describe, expect, it } from 'vitest';
import { buildRowCommand } from '@/components/areas/area-workspace-model';
import { AREA_REGISTRY } from '@/modules/areas/area-registry';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import {
  getRowActions,
  parseBranchActions,
  type RowActionActor,
} from '@/modules/areas/work-actions';
import { AREA_WORK_ROW_COLUMNS, type AreaWorkSqlFilters } from '@/modules/areas/work-rows-sql';
import {
  COUNT_SLA_HOURS,
  MOVEMENT_WINDOW_DAYS,
  VERIFICATION_WORK_ITEM_KIND,
  inventoryWorkRowBranches,
  startOfLocalDay,
} from './work-rows';

/**
 * Branches of Inventario: they must project the canonical columns, keep every
 * value a person can influence as a bound parameter, and declare actions the
 * engine will actually accept.
 */

const NOW = new Date('2026-09-15T18:00:00.000Z');

function filters(overrides: Partial<AreaWorkSqlFilters> = {}): AreaWorkSqlFilters {
  return { areaKey: 'inventario', scope: 'open', now: NOW, ...overrides };
}

function branch(rowKind: string) {
  const found = inventoryWorkRowBranches().find((entry) => entry.rowKind === rowKind);
  if (!found) throw new Error(`Falta la rama ${rowKind}`);
  return found;
}

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: 'stock_count:c-1',
    rowKind: 'stock_count',
    sourceId: 'c-1',
    areaKey: 'inventario',
    caseId: null,
    caseNumber: null,
    customerName: null,
    title: 'Conteo puntual · Bodega principal',
    status: 'in_progress',
    statusLabel: 'En curso',
    statusTone: 'info',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-owner',
    ownerName: 'Ana',
    dueAt: null,
    startedAt: null,
    lastActivityAt: NOW.toISOString(),
    escalationLevel: 0,
    waitReason: null,
    objectType: 'stock_count',
    objectId: 'c-1',
    counterpartyName: 'Bodega principal',
    locationCode: 'principal',
    amount: null,
    quantity: '4',
    version: 3,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

describe('ramas del área', () => {
  it('cubre verificaciones, conteos, reservas, movimientos y compromisos previos, y reemplaza la rama común de trabajos', () => {
    expect(inventoryWorkRowBranches().map((entry) => entry.rowKind)).toStrictEqual([
      'work_item',
      'verification',
      'stock_count',
      'reservation',
      'movement',
      'legacy_claim',
    ]);
  });

  it('las ramas del área son las que el registro declara como tipos de fila', () => {
    const declared = new Set(AREA_REGISTRY.inventario.workCenter.rowKinds);
    for (const entry of inventoryWorkRowBranches()) {
      expect(declared, entry.rowKind).toContain(entry.rowKind);
    }
  });

  it('cada rama proyecta las columnas canónicas en el mismo orden', () => {
    for (const entry of inventoryWorkRowBranches()) {
      const aliases = [
        ...entry.sql(filters({ scope: 'all' })).text.matchAll(/AS "([A-Za-z]+)"/g),
      ].map((match) => match[1]);
      expect(aliases, entry.rowKind).toStrictEqual([...AREA_WORK_ROW_COLUMNS]);
    }
  });

  it('el área y el tipo de trabajo viajan como parámetros, nunca en el texto', () => {
    const sql = branch('verification').sql(filters());
    expect(sql.text).toContain('FROM "WorkItem"');
    expect(sql.text).not.toContain('inventario');
    expect(sql.values).toContain('inventario');
    expect(sql.values).toContain(VERIFICATION_WORK_ITEM_KIND);
  });

  it('los trabajos del área excluyen las verificaciones para no duplicarlas', () => {
    const sql = branch('work_item').sql(filters());
    expect(sql.text).toContain(`'kind' <>`);
    expect(sql.values).toContain(VERIFICATION_WORK_ITEM_KIND);
  });

  it('un identificador escrito por una persona nunca se interpola', () => {
    const attack = 'u-1\'; DROP TABLE "StockItem"; --';
    for (const entry of inventoryWorkRowBranches()) {
      const sql = entry.sql(filters({ ownerUserId: attack, caseId: attack }));
      expect(sql.text, entry.rowKind).not.toContain('DROP TABLE');
      if (entry.rowKind === 'stock_count' || entry.rowKind === 'movement') continue;
      expect(sql.values, entry.rowKind).toContain(attack);
    }
  });

  it('los conteos abiertos vencen con el nivel de servicio del área', () => {
    const sql = branch('stock_count').sql(filters());
    expect(sql.values).toContain(`${COUNT_SLA_HOURS} hours`);
    expect(sql.text).toContain('::interval');
  });

  it('un conteo cerrado con diferencias sin decidir sigue contando como abierto', () => {
    const sql = branch('stock_count').sql(filters());
    // El alcance «abiertos» incluye lo que todavía hay que decidir…
    expect(sql.text).toContain(
      'COALESCE(agg.pending_lines, 0) + COALESCE(agg.disputed_lines, 0) > 0'
    );
    // …pero cerrar y cancelar siguen siendo sólo del conteo en captura.
    const closeAction = sql.text.indexOf(`'actions', CASE WHEN`);
    expect(closeAction).toBeGreaterThan(0);
    expect(sql.text.slice(closeAction, closeAction + 160)).not.toContain('pending_lines');
  });

  it('los movimientos abarcan la ventana de la semana y "abiertos" es hoy', () => {
    const sql = branch('movement').sql(filters());
    const dates = sql.values.filter((value): value is Date => value instanceof Date);
    // La medianoche local viaja dos veces (la columna `open` y el filtro de alcance).
    expect(dates).toHaveLength(3);
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    const windowStart = sorted[0];
    const today = sorted[sorted.length - 1];
    expect(today.toISOString()).toBe(startOfLocalDay(NOW).toISOString());
    expect(sorted[1].toISOString()).toBe(today.toISOString());
    expect((today.getTime() - windowStart.getTime()) / 86_400_000).toBe(MOVEMENT_WINDOW_DAYS - 1);
  });

  it('las reservas sólo se consideran abiertas mientras están activas', () => {
    expect(branch('reservation').sql(filters()).text).toContain(`r."status" = 'active'`);
  });

  it('un compromiso previo sigue abierto mientras está reclamado y vence con su TTL', () => {
    const sql = branch('legacy_claim').sql(filters());
    expect(sql.text).toContain('FROM "LegacyCommitmentClaim"');
    expect(sql.text).toContain(`lc."status" = 'claimed'`);
    // El vencimiento del reclamo ES la fecha de vencimiento de la fila.
    expect(sql.text).toContain('lc."expiresAt"');
  });
});

describe('inicio del día local', () => {
  it('toma la medianoche de la Ciudad de México, no la del servidor', () => {
    // 2026-09-15T18:00Z son las 12:00 en Ciudad de México (UTC-6).
    expect(startOfLocalDay(NOW).toISOString()).toBe('2026-09-15T06:00:00.000Z');
  });

  it('antes de la medianoche UTC sigue siendo el día anterior en México', () => {
    expect(startOfLocalDay(new Date('2026-09-15T02:00:00.000Z')).toISOString()).toBe(
      '2026-09-14T06:00:00.000Z'
    );
  });
});

describe('acciones declaradas por las ramas', () => {
  const countActions = [
    {
      id: 'count.close',
      label: 'Cerrar conteo',
      commandType: 'stock.count.close',
      aggregateType: 'stock_count',
      form: 'none',
      tone: 'primary',
      successMessage: 'Conteo cerrado',
      permissions: ['inventory.count'],
      payload: { countId: 'c-1' },
    },
  ];

  const counter: RowActionActor = {
    id: 'u-other',
    permissionKeys: ['inventory.count'],
    isSuperAdmin: false,
  };

  it('el conteo lleva su id en el payload, que es lo que exige el comando', () => {
    const [action] = getRowActions(row({ extra: { actions: countActions } }), counter);
    expect(action.commandType).toBe('stock.count.close');
    expect(action.payload).toStrictEqual({ countId: 'c-1' });
    expect(buildRowCommand(action, row(), {})).toStrictEqual({
      type: 'stock.count.close',
      aggregate: { type: 'stock_count', id: 'c-1' },
      payload: { countId: 'c-1' },
      expectedVersion: 3,
    });
  });

  it('lo que escribe la persona gana sobre el payload de la rama', () => {
    const [action] = getRowActions(
      row({
        extra: {
          actions: [
            {
              ...countActions[0],
              id: 'reservation.release',
              commandType: 'stock.release',
              aggregateType: 'stock_reservation',
              form: 'reason',
              payload: { reservationId: 'r-1', reason: 'sin motivo' },
            },
          ],
        },
      }),
      { id: 'u-other', permissionKeys: ['inventory.count'], isSuperAdmin: false }
    );
    const command = buildRowCommand(action, row(), { reason: 'ya no se necesita' });
    expect(command.payload).toStrictEqual({
      reservationId: 'r-1',
      reason: 'ya no se necesita',
    });
  });

  it('sin el permiso declarado la acción no se ofrece', () => {
    const stranger: RowActionActor = { id: 'u-x', permissionKeys: [], isSuperAdmin: false };
    expect(getRowActions(row({ extra: { actions: countActions } }), stranger)).toStrictEqual([]);
  });

  it('una verificación sólo la mueve su responsable, su suplente o un gestor', () => {
    const verification = (extra: Record<string, unknown>) =>
      row({
        id: 'verification:w-1',
        rowKind: 'verification',
        sourceId: 'w-1',
        status: 'open',
        extra,
      });
    const actions = [
      {
        id: 'workitem.start',
        label: 'Iniciar',
        commandType: 'workitem.start',
        aggregateType: 'work_item',
        successMessage: 'Verificación iniciada',
        participantOnly: true,
      },
    ];
    const owner: RowActionActor = {
      id: 'u-owner',
      permissionKeys: ['inventory.count'],
      isSuperAdmin: false,
    };
    const backup: RowActionActor = {
      id: 'u-backup',
      permissionKeys: ['inventory.count'],
      isSuperAdmin: false,
    };
    const manager: RowActionActor = {
      id: 'u-boss',
      permissionKeys: ['operations.manage'],
      isSuperAdmin: false,
    };
    const stranger: RowActionActor = {
      id: 'u-x',
      permissionKeys: ['inventory.count', 'inventory.manage'],
      isSuperAdmin: false,
    };

    const options = { actPermissions: ['inventory.count', 'inventory.manage'] };
    expect(getRowActions(verification({ actions }), owner, options)).toHaveLength(1);
    expect(
      getRowActions(verification({ actions, backupUserId: 'u-backup' }), backup, options)
    ).toHaveLength(1);
    expect(getRowActions(verification({ actions }), manager, options)).toHaveLength(1);
    expect(
      getRowActions(verification({ actions }), stranger, {
        actPermissions: ['inventory.count', 'inventory.manage'],
      })
    ).toStrictEqual([]);
  });

  it('las acciones que la rama arma en SQL pasan la validación del marco', () => {
    const sql = branch('verification').sql(filters());
    const declared = sql.values
      .filter((value): value is string => typeof value === 'string' && value.startsWith('[{'))
      .map((value) => parseBranchActions(JSON.parse(value) as unknown));
    expect(declared.length).toBeGreaterThan(0);
    for (const actions of declared) {
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.aggregateType).toBe('work_item');
        expect(action.participantOnly).toBe(true);
        expect(action.commandType.startsWith('workitem.')).toBe(true);
      }
    }
    // Ningún estado abierto se queda sin la acción de completar.
    for (const actions of declared) {
      expect(actions.some((action) => action.id === 'workitem.complete')).toBe(true);
    }
  });

  it('un compromiso previo se libera con su motivo y su id en el payload', () => {
    // La rama arma la acción con `jsonb_build_object`: su vocabulario es del
    // módulo y vive en el texto; lo único que sale de una fila (`lc."id"`) es
    // una columna, nunca algo que una persona haya escrito.
    const sql = branch('legacy_claim').sql(filters());
    for (const literal of [
      `'claim.release'`,
      `'stock.release_legacy'`,
      `'legacy_claim'`,
      `'inventory.reserve'`,
      `'claimId', lc."id"`,
    ]) {
      expect(sql.text, literal).toContain(literal);
    }

    const [action] = parseBranchActions([
      {
        id: 'claim.release',
        label: 'Liberar compromiso',
        commandType: 'stock.release_legacy',
        aggregateType: 'legacy_claim',
        form: 'reason',
        tone: 'danger',
        successMessage: 'Compromiso liberado',
        permissions: ['inventory.reserve'],
        payload: { claimId: 'lc-1' },
      },
    ]);

    // La fila la ofrece a quien puede reservar, y el motivo que escribe la
    // persona gana sobre el payload de la rama (`{claimId}`).
    const claimRow = row({
      id: 'legacy_claim:lc-1',
      rowKind: 'legacy_claim',
      sourceId: 'lc-1',
      status: 'claimed',
      version: 2,
      extra: { actions: [{ ...action, payload: { claimId: 'lc-1' } }] },
    });
    const seller: RowActionActor = {
      id: 'u-seller',
      permissionKeys: ['inventory.reserve'],
      isSuperAdmin: false,
    };
    const [offered] = getRowActions(claimRow, seller, {
      actPermissions: ['inventory.reserve'],
    });
    expect(offered.commandType).toBe('stock.release_legacy');
    expect(
      buildRowCommand(offered, claimRow, { reason: 'El cliente ya no lo espera' })
    ).toStrictEqual({
      type: 'stock.release_legacy',
      aggregate: { type: 'legacy_claim', id: 'lc-1' },
      payload: { claimId: 'lc-1', reason: 'El cliente ya no lo espera' },
      expectedVersion: 2,
    });

    const stranger: RowActionActor = { id: 'u-x', permissionKeys: [], isSuperAdmin: false };
    expect(getRowActions(claimRow, stranger)).toStrictEqual([]);
  });
});
