import { NextResponse } from 'next/server';
import { z } from 'zod';
import { expandNode } from '@/modules/control-tower/graph-service';
import { MAX_GRAPH_NODES } from '@/modules/control-tower/perspectives';
import { controlTowerErrorResponse, readJsonBody, resolveControlTowerRoute } from '../../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Expandir" un nodo del grafo (plan 7.8c): carga sus vecinos directos
 * (profundidad 1) sin volver a recorrer toda la escena, que es lo que permite
 * abrir una red grande poco a poco en vez de pedir 2 000 nodos de golpe.
 */
const bodySchema = z.object({
  perspectiveKey: z.string().trim().min(1).max(40).optional(),
  node: z.object({
    type: z.string().trim().min(1).max(60),
    id: z.string().trim().min(1).max(120),
  }),
  at: z.coerce.date().nullish(),
  limit: z.coerce.number().int().min(1).max(MAX_GRAPH_NODES).optional(),
  relations: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  nodeTypes: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
});

export async function POST(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const input = bodySchema.parse(body.value ?? {});
    const graph = await expandNode(context.user, {
      ...(input.perspectiveKey !== undefined ? { perspectiveKey: input.perspectiveKey } : {}),
      node: input.node,
      ...(input.at !== undefined ? { at: input.at ?? null } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.relations !== undefined ? { relations: input.relations } : {}),
      ...(input.nodeTypes !== undefined ? { nodeTypes: input.nodeTypes } : {}),
    });
    return NextResponse.json({ graph });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
