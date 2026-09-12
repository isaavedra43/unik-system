import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listExports, requestExport } from '@/modules/studio/studio-export-service';
import { STUDIO_EXPORT_FORMATS } from '@/modules/studio/studio-exporters';
import { readJson, requireStudio, studioErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ format: z.enum(STUDIO_EXPORT_FORMATS as [string, ...string[]]) });

export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ exports: await listExports(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}

/** POST {format} — renders, verifies and stores; returns the export state (poll GET /exports/:id). */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = bodySchema.parse(await readJson(request));
    const result = await requestExport(
      auth.user,
      id,
      body.format as (typeof STUDIO_EXPORT_FORMATS)[number]
    );
    return NextResponse.json({ export: result }, { status: 201 });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
