import { NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOperationalGraph, GRAPH_ROOT_LIMIT } from '@/modules/control-tower/graph-service';
import {
  DEFAULT_PERSPECTIVE_KEY,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  listPerspectivesFor,
} from '@/modules/control-tower/perspectives';
import { maskedFieldsFor } from '@/modules/control-tower/graph-mask';
import {
  controlTowerErrorResponse,
  dateParam,
  intParam,
  listParam,
  readJsonBody,
  resolveControlTowerRoute,
} from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Grafo operativo (plan 7.8c / 7.9). `GET` responde el catálogo de perspectivas
 * que esta persona puede abrir (y, con `?rootType`/`?rootId`, ya recorre desde
 * ahí, para enlaces compartibles). `POST` recorre con varias raíces y filtros.
 *
 * Profundidad ≤ 3 y tope de 2 000 nodos: el servicio los acota, no la pantalla.
 */
const refSchema = z.object({
  type: z.string().trim().min(1).max(60),
  id: z.string().trim().min(1).max(120),
});

const bodySchema = z.object({
  perspectiveKey: z.string().trim().min(1).max(40).optional(),
  roots: z.array(refSchema).max(GRAPH_ROOT_LIMIT).default([]),
  depth: z.coerce.number().int().min(1).max(MAX_GRAPH_DEPTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_GRAPH_NODES).optional(),
  at: z.coerce.date().nullish(),
  relations: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  nodeTypes: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
});

export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  const perspectives = listPerspectivesFor({
    permissionKeys: context.user.permissionKeys,
    isSuperAdmin: context.user.isSuperAdmin === true,
  }).map((perspective) => ({
    key: perspective.key,
    label: perspective.label,
    description: perspective.description,
    rootTypes: perspective.rootTypes,
    nodeTypes: perspective.nodeTypes,
    relations: perspective.relations,
    defaultDepth: perspective.defaultDepth,
  }));

  const rootType = params.get('rootType')?.trim() ?? '';
  const rootId = params.get('rootId')?.trim() ?? '';
  const base = {
    perspectives,
    defaultPerspectiveKey: perspectives.some((p) => p.key === DEFAULT_PERSPECTIVE_KEY)
      ? DEFAULT_PERSPECTIVE_KEY
      : (perspectives[0]?.key ?? null),
    maskedFields: maskedFieldsFor({
      permissionKeys: context.user.permissionKeys,
      isSuperAdmin: context.user.isSuperAdmin === true,
    }),
    maxDepth: MAX_GRAPH_DEPTH,
    maxNodes: MAX_GRAPH_NODES,
  };
  if (!rootType || !rootId) return NextResponse.json({ ...base, graph: null });

  try {
    const graph = await queryOperationalGraph(context.user, {
      perspectiveKey: params.get('perspectiveKey'),
      roots: [{ type: rootType, id: rootId }],
      depth: intParam(params, 'depth', { min: 1, max: MAX_GRAPH_DEPTH }),
      limit: intParam(params, 'limit', { min: 1, max: MAX_GRAPH_NODES }),
      at: dateParam(params, 'at'),
      relations: listParam(params, 'relation', 60),
      nodeTypes: listParam(params, 'nodeType', 60),
    });
    return NextResponse.json({ ...base, graph });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const input = bodySchema.parse(body.value ?? {});
    const graph = await queryOperationalGraph(context.user, {
      ...(input.perspectiveKey !== undefined ? { perspectiveKey: input.perspectiveKey } : {}),
      roots: input.roots,
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.at !== undefined ? { at: input.at ?? null } : {}),
      ...(input.relations !== undefined ? { relations: input.relations } : {}),
      ...(input.nodeTypes !== undefined ? { nodeTypes: input.nodeTypes } : {}),
    });
    return NextResponse.json({ graph });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
