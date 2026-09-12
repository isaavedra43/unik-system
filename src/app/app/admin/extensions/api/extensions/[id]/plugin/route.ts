import { NextRequest, NextResponse } from 'next/server';
import {
  requireExtensionsAdmin,
  extensionErrorResponse,
} from '@/app/app/assistant/api/extensions/_shared';
import { importPluginPackage, PLUGIN_MAX_BYTES } from '@/modules/extensions/plugin-importer';
import { installPluginVersion } from '@/modules/extensions/plugin-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST (multipart: file) — validates a plugin package (manifest, skills,
 * templates, docs, fixtures; no secrets, no code) and installs it as a new
 * DRAFT version of the extension. Content-addressed: re-uploading the same
 * package returns the existing version.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || !(file instanceof File))
      return NextResponse.json({ error: 'Falta el archivo del plugin' }, { status: 400 });
    if (file.size > PLUGIN_MAX_BYTES)
      return NextResponse.json({ error: 'El paquete excede 5 MB' }, { status: 413 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const imported = await importPluginPackage(buffer);
    const result = await installPluginVersion(auth.user, id, imported);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
