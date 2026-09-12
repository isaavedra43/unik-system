import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { ExtensionError } from '@/modules/extensions/extensions-service';
import { ConnectionError } from '@/modules/extensions/connections-service';
import { SkillError } from '@/modules/extensions/skills-service';
import { SkillRunError } from '@/modules/extensions/skill-runner';
import { McpError } from '@/modules/extensions/mcp-client-service';
import { ApiRuntimeError } from '@/modules/extensions/api-runtime';
import { EgressError } from '@/modules/extensions/safe-fetch';
import { PluginImportError } from '@/modules/extensions/plugin-importer';
import { OpenApiImportError } from '@/modules/extensions/openapi-importer';
import { ZodError } from 'zod';

export async function requireAssistantUser(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'assistant.use')) {
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  }
  return { user: session.user };
}

/** Administration of extensions needs its own permission; assistant access is not enough. */
export async function requireExtensionsAdmin(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'extensions.manage')) {
    return {
      response: NextResponse.json(
        { error: 'Sin permiso para administrar extensiones' },
        { status: 403 }
      ),
    };
  }
  return { user: session.user };
}

export async function requireExtensionsViewer(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (
    !hasPermission(session.user, 'extensions.view') &&
    !hasPermission(session.user, 'extensions.manage')
  ) {
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  }
  return { user: session.user };
}

export function extensionErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof ExtensionError ||
    err instanceof ConnectionError ||
    err instanceof SkillError ||
    err instanceof SkillRunError
  ) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  }
  if (err instanceof McpError || err instanceof ApiRuntimeError || err instanceof EgressError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 502 });
  }
  if (err instanceof PluginImportError || err instanceof OpenApiImportError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : 'Error desconocido';
  console.error('[extensions-api]', message);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}
