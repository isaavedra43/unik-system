import { NextResponse } from 'next/server';
import {
  deleteGraphScene,
  getGraphScene,
  updateGraphScene,
  type SceneUpdateInput,
} from '@/modules/control-tower/scenes-service';
import { controlTowerErrorResponse, readJsonBody, resolveControlTowerRoute } from '../../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Una escena: leerla, guardarla (sólo su dueño) o borrarla (sólo su dueño). */
export async function GET(_request: Request, { params }: Params) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  try {
    const { id } = await params;
    return NextResponse.json({ scene: await getGraphScene(context.user, id) });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const { id } = await params;
    const scene = await updateGraphScene(context.user, id, (body.value ?? {}) as SceneUpdateInput);
    return NextResponse.json({ scene });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  try {
    const { id } = await params;
    return NextResponse.json(await deleteGraphScene(context.user, id));
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
