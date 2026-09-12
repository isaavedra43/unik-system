import { createHash } from 'crypto';
import { z } from 'zod';
import {
  bufferRandomAccess,
  isTraversalName,
  readZipDirectory,
  readZipEntry,
} from '@/modules/storage/zip-reader';
import { skillDefinitionSchema } from './skills-service';
import { canonicalJson } from './json-schema-to-zod';

/**
 * Plugin package importer.
 *
 * A plugin is a ZIP with a JSON manifest that groups declarative skills,
 * references to connections, typed operations (API), templates, docs and
 * test fixtures. The package NEVER contains secrets or executable code: only
 * JSON, Markdown and text templates are accepted. Every version is identified
 * by the hash of its content.
 */

export const PLUGIN_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.json', '.md', '.txt', '.hbs', '.html', '.csv']);

export const pluginManifestSchema = z.object({
  manifestVersion: z.literal(1),
  namespace: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  name: z.string().min(2).max(120),
  version: z.string().min(1).max(40),
  description: z.string().max(2000).optional(),
  /** Connections the plugin expects (the admin creates/binds them; never stored in the package). */
  connections: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        authType: z.enum(['oauth2', 'api_key', 'bearer', 'basic']),
        scopeType: z.enum(['team', 'personal']).default('team'),
        description: z.string().max(500).optional(),
      })
    )
    .max(10)
    .default([]),
  api: z
    .object({
      baseUrl: z.string().url(),
      allowedHosts: z.array(z.string().max(253)).max(10),
      apiKeyHeader: z.string().max(60).optional(),
    })
    .optional(),
  operations: z
    .array(
      z.object({
        operationId: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).max(300),
        summary: z.string().max(300).default(''),
        pathParams: z.record(z.unknown()).default({ type: 'object', properties: {} }),
        queryParams: z.record(z.unknown()).default({ type: 'object', properties: {} }),
        bodySchema: z.record(z.unknown()).nullable().default(null),
        responseFields: z.array(z.string().max(200)).max(50).default([]),
        fixtures: z.record(z.unknown()).default({}),
        suggestedEffect: z
          .enum([
            'read',
            'draft',
            'internal_task',
            'external_send',
            'business_write',
            'destructive',
          ])
          .default('business_write'),
      })
    )
    .max(100)
    .default([]),
  skills: z
    .array(
      z.object({
        key: z
          .string()
          .min(3)
          .max(60)
          .regex(/^[a-z][a-z0-9_-]*$/),
        name: z.string().min(2).max(120),
        purpose: z.string().max(1000),
        /** Path inside the package to the skill definition JSON. */
        file: z.string().min(1).max(200),
      })
    )
    .max(50)
    .default([]),
  templates: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        file: z.string().min(1).max(200),
        description: z.string().max(300).optional(),
      })
    )
    .max(50)
    .default([]),
  docs: z.array(z.string().max(200)).max(50).default([]),
  contextTags: z.array(z.string().max(40)).max(20).default(['all']),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export interface ImportedPlugin {
  manifest: PluginManifest;
  contentHash: string;
  skills: Array<{
    key: string;
    name: string;
    purpose: string;
    definition: z.infer<typeof skillDefinitionSchema>;
  }>;
  templates: Array<{ key: string; description?: string; content: string }>;
  docs: Array<{ path: string; content: string }>;
  files: string[];
  warnings: string[];
}

export class PluginImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginImportError';
  }
}

const SECRET_LIKE =
  /(api[_-]?key|secret|password|token)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/i;

function extension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

export async function importPluginPackage(buffer: Buffer): Promise<ImportedPlugin> {
  if (buffer.length > PLUGIN_MAX_BYTES) throw new PluginImportError('El paquete excede 5 MB');
  const access = bufferRandomAccess(buffer);
  const dir = await readZipDirectory(access, { maxEntries: MAX_ENTRIES });
  if (dir.zip64) throw new PluginImportError('Paquetes ZIP64 no admitidos');

  const files = new Map<string, Buffer>();
  for (const entry of dir.entries) {
    if (entry.isDirectory) continue;
    if (isTraversalName(entry.name))
      throw new PluginImportError(`Ruta no permitida en el paquete: ${entry.name}`);
    const ext = extension(entry.name);
    if (!ALLOWED_EXTENSIONS.has(ext))
      throw new PluginImportError(`Tipo de archivo no permitido en el paquete: ${entry.name}`);
    if (entry.uncompressedSize > MAX_ENTRY_BYTES)
      throw new PluginImportError(`Archivo demasiado grande: ${entry.name}`);
    const content = await readZipEntry(access, entry, MAX_ENTRY_BYTES);
    files.set(entry.name.replace(/^\.\//, ''), content);
  }

  const manifestRaw = files.get('manifest.json') ?? files.get('plugin.json');
  if (!manifestRaw) throw new PluginImportError('Falta manifest.json');
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw.toString('utf8'));
  } catch {
    throw new PluginImportError('manifest.json no es JSON válido');
  }
  const parsed = pluginManifestSchema.safeParse(manifestJson);
  if (!parsed.success)
    throw new PluginImportError(
      `Manifiesto inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  const manifest = parsed.data;

  const warnings: string[] = [];
  for (const [name, content] of files) {
    const text = content.toString('utf8');
    if (SECRET_LIKE.test(text))
      throw new PluginImportError(
        `El archivo ${name} parece contener un secreto; los paquetes no pueden incluir credenciales`
      );
    if (/<script[\s>]/i.test(text) && extension(name) !== '.md')
      throw new PluginImportError(
        `El archivo ${name} contiene scripts; no se permite código ejecutable`
      );
  }

  const skills: ImportedPlugin['skills'] = [];
  for (const skill of manifest.skills) {
    const raw = files.get(skill.file);
    if (!raw)
      throw new PluginImportError(`No existe el archivo de la skill ${skill.key}: ${skill.file}`);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new PluginImportError(`La skill ${skill.key} no es JSON válido`);
    }
    const def = skillDefinitionSchema.safeParse(json);
    if (!def.success)
      throw new PluginImportError(
        `Skill ${skill.key} inválida: ${def.error.issues.map((i) => i.message).join('; ')}`
      );
    skills.push({ key: skill.key, name: skill.name, purpose: skill.purpose, definition: def.data });
  }

  const templates = manifest.templates.map((t) => {
    const raw = files.get(t.file);
    if (!raw) throw new PluginImportError(`No existe la plantilla ${t.key}: ${t.file}`);
    return { key: t.key, description: t.description, content: raw.toString('utf8') };
  });
  const docs = manifest.docs
    .map((path) => {
      const raw = files.get(path);
      if (!raw) {
        warnings.push(`Documento no encontrado: ${path}`);
        return null;
      }
      return { path, content: raw.toString('utf8') };
    })
    .filter((d): d is { path: string; content: string } => d !== null);

  if (manifest.api) {
    let base: URL;
    try {
      base = new URL(manifest.api.baseUrl);
    } catch {
      throw new PluginImportError('api.baseUrl inválida');
    }
    if (base.protocol !== 'https:') throw new PluginImportError('api.baseUrl debe ser HTTPS');
  }

  const contentHash = createHash('sha256')
    .update(
      canonicalJson({
        manifest,
        files: [...files.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([n, c]) => [n, createHash('sha256').update(c).digest('hex')]),
      })
    )
    .digest('hex');

  return { manifest, contentHash, skills, templates, docs, files: [...files.keys()], warnings };
}
