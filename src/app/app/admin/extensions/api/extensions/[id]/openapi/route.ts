import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireExtensionsAdmin,
  extensionErrorResponse,
  readJson,
} from '@/app/app/assistant/api/extensions/_shared';
import { importOpenApiIntoExtension } from '@/modules/extensions/extensions-service';
import { importOpenApi } from '@/modules/extensions/openapi-importer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  /** OpenAPI 3.x document as JSON (YAML must be converted client-side or pasted as JSON). */
  document: z.record(z.unknown()),
  /** Operation ids to import. Empty/omitted with preview=true only lists them. */
  selected: z.array(z.string().max(80)).max(200).optional(),
  preview: z.boolean().optional(),
});

/** POST — preview or import selected operations from an OpenAPI 3.x document (no external $ref is fetched). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    if (body.preview) {
      const result = importOpenApi(body.document);
      return NextResponse.json({
        title: result.title,
        servers: result.servers,
        warnings: result.warnings,
        operations: result.operations.map((o) => ({
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary,
          suggestedEffect: o.suggestedEffect,
          deprecated: o.deprecated,
        })),
      });
    }
    const result = await importOpenApiIntoExtension(auth.user, id, body.document, body.selected);
    return NextResponse.json({
      versionId: result.version.id,
      imported: result.imported,
      warnings: result.warnings,
    });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
