import { NextResponse } from 'next/server';
import {
  createGraphScene,
  listGraphScenes,
  type SceneInput,
} from '@/modules/control-tower/scenes-service';
import { controlTowerErrorResponse, readJsonBody, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Escenas guardadas del explorador del grafo (plan 7.8c).
 * `GET` lista las propias y las compartidas cuya perspectiva se puede abrir;
 * `POST` guarda una nueva del usuario de la sesión.
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  try {
    const perspectiveKey = new URL(request.url).searchParams.get('perspectiveKey');
    const scenes = await listGraphScenes(context.user, { perspectiveKey });
    return NextResponse.json({ scenes });
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
    const scene = await createGraphScene(context.user, (body.value ?? {}) as SceneInput);
    return NextResponse.json({ scene }, { status: 201 });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
