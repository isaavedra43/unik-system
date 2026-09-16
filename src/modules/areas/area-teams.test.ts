import { describe, expect, it } from 'vitest';
import { AREA_LIST } from './area-registry';
import {
  areaTeamRoleDefinitions,
  areaTeamRoleKey,
  areaTeamRoleKeys,
  ensureAreaTeamRoles,
  type AreaTeamRoleDb,
} from './area-teams';

/**
 * El registro declaraba `inboxTeamKeys: ['equipo_ventas']` desde el principio y
 * NADIE creaba esos roles: el selector de canales sólo ofrece roles activos, así
 * que la pestaña «Externos» de las seis áreas abría vacía para siempre. Estas
 * pruebas fijan las dos mitades del contrato: una llave por área, derivada del
 * registro, y un seed que crea lo que falta sin tocar lo que ya existe.
 */

interface FakeRole {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  isActive: boolean;
}

function fakeDb(existing: FakeRole[] = []): AreaTeamRoleDb & { rows: FakeRole[] } {
  const rows = [...existing];
  return {
    rows,
    role: {
      async createMany({ data, skipDuplicates }) {
        let count = 0;
        for (const row of data) {
          if (skipDuplicates && rows.some((current) => current.key === row.key)) continue;
          rows.push({ ...row });
          count += 1;
        }
        return { count };
      },
      async findMany({ where }) {
        return rows
          .filter((row) => where.key.in.includes(row.key))
          .map((row) => ({ key: row.key, isActive: row.isActive }));
      },
    },
  };
}

describe('roles de equipo de las áreas', () => {
  it('hay exactamente una llave por área y es la que declara el registro', () => {
    const definitions = areaTeamRoleDefinitions();
    expect(definitions).toHaveLength(AREA_LIST.length);
    for (const area of AREA_LIST) {
      const found = definitions.find((role) => role.areaKey === area.key);
      expect(found?.key, area.key).toBe(area.comms.inboxTeamKeys[0]);
      expect(found?.key, area.key).toBe(`equipo_${area.key}`);
      expect(found?.name, area.key).toBe(`Equipo ${area.label}`);
    }
    expect(new Set(definitions.map((role) => role.key)).size).toBe(definitions.length);
    expect(areaTeamRoleKeys().sort()).toStrictEqual(definitions.map((role) => role.key).sort());
    expect(areaTeamRoleKey(AREA_LIST[0])).toBe(AREA_LIST[0].comms.inboxTeamKeys[0]);
  });

  it('crea los seis roles la primera vez, sin marcarlos de sistema', async () => {
    const db = fakeDb();
    const summary = await ensureAreaTeamRoles(db);
    expect(summary).toStrictEqual({ created: AREA_LIST.length, inactive: [], missing: [] });
    expect(db.rows.map((row) => row.key).sort()).toStrictEqual(areaTeamRoleKeys().sort());
    // Roles editables: Administración les da permisos y personas.
    for (const row of db.rows) expect(row.isSystem).toBe(false);
  });

  it('es idempotente y nunca reescribe un rol que ya existe', async () => {
    const db = fakeDb([
      {
        key: 'equipo_ventas',
        name: 'Mesa comercial',
        description: 'Renombrado por Administración',
        isSystem: false,
        isActive: true,
      },
    ]);
    const first = await ensureAreaTeamRoles(db);
    expect(first.created).toBe(AREA_LIST.length - 1);
    const second = await ensureAreaTeamRoles(db);
    expect(second).toStrictEqual({ created: 0, inactive: [], missing: [] });
    expect(db.rows.find((row) => row.key === 'equipo_ventas')?.name).toBe('Mesa comercial');
  });

  it('reporta un rol desactivado en vez de reactivarlo a espaldas de Administración', async () => {
    const db = fakeDb([
      {
        key: 'equipo_compras',
        name: 'Equipo Compras',
        description: '',
        isSystem: false,
        isActive: false,
      },
    ]);
    const summary = await ensureAreaTeamRoles(db);
    expect(summary.inactive).toStrictEqual(['equipo_compras']);
    expect(db.rows.find((row) => row.key === 'equipo_compras')?.isActive).toBe(false);
  });
});
