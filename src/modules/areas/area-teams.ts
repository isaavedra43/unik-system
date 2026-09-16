import { prisma } from '@/lib/prisma';
import { AREA_LIST, type AreaMeta } from './area-registry';

/**
 * Roles de equipo de las áreas (plan 7.2: «roles `equipo_<área>` creados si no
 * existen y mapeados a `CommAccount.teamKeys`»).
 *
 * POR QUÉ EXISTE ESTE ARCHIVO. El registro de áreas declara desde el principio
 * `comms.inboxTeamKeys = ['equipo_ventas']`, y la pestaña «externos» de cada
 * área filtra las cuentas de bandeja por esa llave
 * (`AreaCommsPage` → `CommAccount.teamKeys`). Pero nadie creaba los roles: el
 * selector de «Canales y responsables» sólo ofrece ROLES ACTIVOS, así que un
 * administrador no podía marcar el equipo del área ni aunque quisiera y las
 * seis pestañas abrían vacías para siempre, sin explicación.
 *
 * QUÉ HACE. Crea el rol que falta y NADA MÁS:
 * - `createMany … skipDuplicates` (ON CONFLICT DO NOTHING), así que es idempotente
 *   y aguanta varias instancias arrancando a la vez;
 * - NO son roles de sistema: un administrador puede renombrarlos, darles
 *   permisos, asignar personas y desactivarlos. Un rol que ya existe no se
 *   toca nunca (ni se reactiva), para no deshacer una decisión de Administración;
 * - NO asigna la llave a ninguna `CommAccount`: qué número de WhatsApp atiende
 *   cada equipo es una decisión de negocio que se toma en
 *   `/app/admin/comms` (pestaña Canales), no algo que el arranque adivine.
 *
 * El rol es una ETIQUETA DE EQUIPO, no un paquete de permisos: `canAccessAccount`
 * compara `CommAccount.teamKeys` contra `user.roleKeys`, de modo que basta con
 * que la persona tenga el rol (más `inbox.use`) para ver la bandeja del área.
 */

export interface AreaTeamRole {
  areaKey: string;
  key: string;
  name: string;
  description: string;
}

/** Llave del rol de equipo de un área (la que el registro ya declara). */
export function areaTeamRoleKey(area: AreaMeta): string {
  return area.comms.inboxTeamKeys[0] ?? `equipo_${area.key}`;
}

/** Un rol por área, derivado del registro: aquí no se repite ninguna llave. */
export function areaTeamRoleDefinitions(): AreaTeamRole[] {
  return AREA_LIST.map((area) => ({
    areaKey: area.key,
    key: areaTeamRoleKey(area),
    name: `Equipo ${area.label}`,
    description: `Equipo de ${area.label}: marca este rol en los canales de la bandeja (WhatsApp, SMS, Telegram) que atiende el área para que aparezcan en su pestaña «Externos».`,
  }));
}

/** Toda llave de equipo que el registro declara (para pruebas y diagnóstico). */
export function areaTeamRoleKeys(): string[] {
  return [...new Set(AREA_LIST.flatMap((area) => [...area.comms.inboxTeamKeys]))];
}

/** Lo mínimo que necesita el seed: se inyecta en las pruebas. */
export interface AreaTeamRoleDb {
  role: {
    createMany(args: {
      data: Array<{
        key: string;
        name: string;
        description: string;
        isSystem: boolean;
        isActive: boolean;
      }>;
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
    findMany(args: {
      where: { key: { in: string[] } };
      select: { key: true; isActive: true };
    }): Promise<Array<{ key: string; isActive: boolean }>>;
  };
}

export interface EnsureAreaTeamRolesSummary {
  created: number;
  /** Roles que existen pero un administrador desactivó (no se reactivan). */
  inactive: string[];
  /** Llaves declaradas por el registro que siguen sin rol (no debería pasar). */
  missing: string[];
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'area-teams', event, ...extra }));

/**
 * Crea los roles de equipo que falten. Idempotente y segura con varias
 * instancias arrancando a la vez; nunca modifica un rol existente.
 */
export async function ensureAreaTeamRoles(
  db: AreaTeamRoleDb = prisma as unknown as AreaTeamRoleDb
): Promise<EnsureAreaTeamRolesSummary> {
  const definitions = areaTeamRoleDefinitions();
  const { count } = await db.role.createMany({
    data: definitions.map((role) => ({
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: false,
      isActive: true,
    })),
    skipDuplicates: true,
  });

  const keys = definitions.map((role) => role.key);
  const rows = await db.role.findMany({
    where: { key: { in: keys } },
    select: { key: true, isActive: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.isActive]));
  const summary: EnsureAreaTeamRolesSummary = {
    created: count,
    inactive: keys.filter((key) => byKey.get(key) === false),
    missing: keys.filter((key) => !byKey.has(key)),
  };
  if (summary.created > 0 || summary.inactive.length > 0 || summary.missing.length > 0) {
    log('ensured', { ...summary });
  }
  return summary;
}
