import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { assertControlTowerAccess } from './control-tower-service';
import { canUsePerspective, getPerspective, MAX_GRAPH_DEPTH } from './perspectives';
import { GRAPH_ROOT_LIMIT, type GraphRef } from './graph-service';

/**
 * Escenas guardadas del explorador del grafo (`CtGraphScene`, plan 7.8c).
 * SÓLO SERVIDOR.
 *
 * Una escena es "cómo quiero volver a ver esta red": perspectiva, raíces,
 * filtros, posiciones de los nodos y, opcionalmente, el instante fijado.
 *
 * Reglas de acceso:
 * - la Torre de Control exige `operations.admin` (guarda del módulo);
 * - una escena PROPIA la ve, edita y borra su dueño;
 * - una escena COMPARTIDA (`shared`) la puede abrir cualquiera que tenga
 *   permiso de la perspectiva, pero sólo su dueño la edita o la borra;
 * - una escena cuya perspectiva ya no se puede abrir NO se lista (si alguien
 *   pierde el permiso de Contabilidad, deja de ver las escenas de dinero).
 *
 * El `layout` y los `filters` son JSON de la pantalla: se guardan tal cual,
 * acotados en tamaño, y nunca se ejecutan ni se interpretan como instrucciones.
 */

/** Tope de escenas por persona: una lista, no un archivo muerto. */
export const MAX_SCENES_PER_USER = 100;

const MAX_JSON_BYTES = 256 * 1024;

const refSchema = z.object({
  type: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'Tipo de nodo inválido'),
  id: z.string().trim().min(1).max(120),
});

export const sceneInputSchema = z.object({
  name: z.string().trim().min(1, 'Ponle un nombre a la escena').max(80),
  perspectiveKey: z.string().trim().min(1).max(40),
  roots: z.array(refSchema).min(1, 'Elige al menos un punto de partida').max(GRAPH_ROOT_LIMIT),
  filters: z.record(z.string(), z.unknown()).nullish(),
  layout: z.record(z.string(), z.unknown()).nullish(),
  at: z.coerce.date().nullish(),
  shared: z.boolean().default(false),
  depth: z.coerce.number().int().min(1).max(MAX_GRAPH_DEPTH).nullish(),
});

export type SceneInput = z.input<typeof sceneInputSchema>;

export const sceneUpdateSchema = sceneInputSchema.partial().extend({
  /** Versión leída por la pantalla: si cambió, alguien más la guardó antes. */
  expectedVersion: z.coerce.number().int().min(1).optional(),
});

export type SceneUpdateInput = z.input<typeof sceneUpdateSchema>;

export interface GraphScene {
  id: string;
  name: string;
  perspectiveKey: string;
  perspectiveLabel: string;
  roots: GraphRef[];
  filters: Record<string, unknown> | null;
  layout: Record<string, unknown> | null;
  at: string | null;
  shared: boolean;
  version: number;
  ownerUserId: string;
  ownerName: string | null;
  mine: boolean;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SceneRow {
  id: string;
  userId: string;
  name: string;
  perspectiveKey: string;
  roots: Prisma.JsonValue;
  filters: Prisma.JsonValue | null;
  layout: Prisma.JsonValue | null;
  at: Date | null;
  shared: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function assertJsonSize(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > MAX_JSON_BYTES) {
    throw new OperationsError('invalid_request', `La escena es demasiado grande (${field})`);
  }
}

function parseRefs(value: Prisma.JsonValue | null | undefined): GraphRef[] {
  if (!Array.isArray(value)) return [];
  const out: GraphRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const type = typeof raw.type === 'string' ? raw.type : '';
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!type || !id) continue;
    out.push({ type, id });
    if (out.length >= GRAPH_ROOT_LIMIT) break;
  }
  return out;
}

function parseObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toScene(row: SceneRow, actor: CurrentUser, names: Map<string, string>): GraphScene {
  const perspective = getPerspective(row.perspectiveKey);
  const mine = row.userId === actor.id;
  return {
    id: row.id,
    name: row.name,
    perspectiveKey: row.perspectiveKey,
    perspectiveLabel: perspective?.label ?? row.perspectiveKey,
    roots: parseRefs(row.roots),
    filters: parseObject(row.filters),
    layout: parseObject(row.layout),
    at: row.at ? row.at.toISOString() : null,
    shared: row.shared,
    version: row.version,
    ownerUserId: row.userId,
    ownerName: names.get(row.userId) ?? null,
    mine,
    canEdit: mine,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolveNames(rows: readonly SceneRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.userId))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, username: true },
  });
  return new Map(users.map((user) => [user.id, user.name || user.username]));
}

/** Perspectivas que el actor puede abrir (las demás no se listan ni se leen). */
function assertPerspective(actor: CurrentUser, key: string): void {
  const perspective = getPerspective(key);
  if (!perspective) throw new OperationsError('not_found', 'Esa perspectiva no existe');
  if (
    !canUsePerspective(
      { permissionKeys: actor.permissionKeys, isSuperAdmin: actor.isSuperAdmin === true },
      perspective
    )
  ) {
    throw new OperationsError('forbidden', 'No tienes permiso para esa perspectiva');
  }
}

function canSee(actor: CurrentUser, row: SceneRow): boolean {
  if (row.userId === actor.id) return true;
  if (!row.shared) return false;
  const perspective = getPerspective(row.perspectiveKey);
  if (!perspective) return false;
  return canUsePerspective(
    { permissionKeys: actor.permissionKeys, isSuperAdmin: actor.isSuperAdmin === true },
    perspective
  );
}

/** Escenas propias y compartidas que el actor puede abrir. */
export async function listGraphScenes(
  actor: CurrentUser,
  options: { perspectiveKey?: string | null } = {}
): Promise<GraphScene[]> {
  assertControlTowerAccess(actor);
  const rows = (await prisma.ctGraphScene.findMany({
    where: {
      OR: [{ userId: actor.id }, { shared: true }],
      ...(options.perspectiveKey ? { perspectiveKey: options.perspectiveKey } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: 500,
  })) as SceneRow[];
  const visible = rows.filter((row) => canSee(actor, row));
  const names = await resolveNames(visible);
  return visible.map((row) => toScene(row, actor, names));
}

export async function getGraphScene(actor: CurrentUser, id: string): Promise<GraphScene> {
  assertControlTowerAccess(actor);
  const row = (await prisma.ctGraphScene.findUnique({ where: { id } })) as SceneRow | null;
  if (!row || !canSee(actor, row)) {
    throw new OperationsError('not_found', 'No encontramos esa escena');
  }
  const names = await resolveNames([row]);
  return toScene(row, actor, names);
}

/** Guarda una escena nueva del actor. */
export async function createGraphScene(actor: CurrentUser, input: SceneInput): Promise<GraphScene> {
  assertControlTowerAccess(actor);
  const parsed = sceneInputSchema.parse(input);
  assertPerspective(actor, parsed.perspectiveKey);
  assertJsonSize(parsed.filters, 'filtros');
  assertJsonSize(parsed.layout, 'trazado');

  const count = await prisma.ctGraphScene.count({ where: { userId: actor.id } });
  if (count >= MAX_SCENES_PER_USER) {
    throw new OperationsError(
      'invalid_request',
      `Ya tienes ${MAX_SCENES_PER_USER} escenas guardadas; borra alguna para guardar otra`
    );
  }

  const row = (await prisma.ctGraphScene.create({
    data: {
      userId: actor.id,
      name: parsed.name,
      perspectiveKey: parsed.perspectiveKey,
      roots: parsed.roots as unknown as Prisma.InputJsonValue,
      filters: toJson(withDepth(parsed.filters, parsed.depth)),
      layout: toJson(parsed.layout ?? null),
      at: parsed.at ?? null,
      shared: parsed.shared,
    },
  })) as SceneRow;
  const names = await resolveNames([row]);
  return toScene(row, actor, names);
}

function withDepth(
  filters: Record<string, unknown> | null | undefined,
  depth: number | null | undefined
): Record<string, unknown> | null {
  if (depth === null || depth === undefined) return filters ?? null;
  return { ...(filters ?? {}), depth };
}

function toJson(
  value: Record<string, unknown> | null
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/**
 * Actualiza una escena propia. Con `expectedVersion` la escritura es optimista:
 * si otra pestaña guardó antes, se devuelve un conflicto en vez de pisarla.
 */
export async function updateGraphScene(
  actor: CurrentUser,
  id: string,
  input: SceneUpdateInput
): Promise<GraphScene> {
  assertControlTowerAccess(actor);
  const parsed = sceneUpdateSchema.parse(input);
  const current = (await prisma.ctGraphScene.findUnique({ where: { id } })) as SceneRow | null;
  if (!current || !canSee(actor, current)) {
    throw new OperationsError('not_found', 'No encontramos esa escena');
  }
  if (current.userId !== actor.id) {
    throw new OperationsError('forbidden', 'Sólo quien creó la escena puede cambiarla');
  }
  if (parsed.perspectiveKey) assertPerspective(actor, parsed.perspectiveKey);
  assertJsonSize(parsed.filters, 'filtros');
  assertJsonSize(parsed.layout, 'trazado');

  const data: Prisma.CtGraphSceneUpdateManyMutationInput = { version: { increment: 1 } };
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.perspectiveKey !== undefined) data.perspectiveKey = parsed.perspectiveKey;
  if (parsed.roots !== undefined) data.roots = parsed.roots as unknown as Prisma.InputJsonValue;
  if (parsed.filters !== undefined || parsed.depth !== undefined) {
    data.filters = toJson(withDepth(parsed.filters ?? parseObject(current.filters), parsed.depth));
  }
  if (parsed.layout !== undefined) data.layout = toJson(parsed.layout ?? null);
  if (parsed.at !== undefined) data.at = parsed.at ?? null;
  if (parsed.shared !== undefined) data.shared = parsed.shared;

  const updated = await prisma.ctGraphScene.updateMany({
    where: {
      id,
      userId: actor.id,
      ...(parsed.expectedVersion ? { version: parsed.expectedVersion } : {}),
    },
    data,
  });
  if (updated.count === 0) {
    throw new OperationsError(
      'version_conflict',
      'Alguien más guardó esta escena; vuelve a abrirla para no perder su trabajo'
    );
  }
  return getGraphScene(actor, id);
}

/** Borra una escena propia. */
export async function deleteGraphScene(actor: CurrentUser, id: string): Promise<{ id: string }> {
  assertControlTowerAccess(actor);
  const deleted = await prisma.ctGraphScene.deleteMany({ where: { id, userId: actor.id } });
  if (deleted.count === 0) {
    throw new OperationsError(
      'not_found',
      'No encontramos esa escena tuya (una escena ajena sólo la borra quien la creó)'
    );
  }
  return { id };
}
