import { z } from 'zod';
import { registerTool } from './registry';
import {
  listSites,
  publishSite,
  setSiteStatus,
  SiteError,
  MAX_SITE_FILES,
  normalizeSitePath,
  type SiteFileInput,
} from '@/modules/sites/site-service';
import {
  acquireVenue,
  isVenueEnabled,
  VenueUnavailableError,
} from '@/modules/venues/venue-manager';
import { shq } from '@/modules/venues/daytona-venue';

/**
 * Websites the agents build and publish (UNIVERSO use cases "crea y publica
 * una página web" and "nuevo negocio desde una idea").
 *
 * Two ways to publish:
 *   - `files`: the model writes the HTML/CSS/JS itself (landing pages);
 *   - `fromVenueDir`: a folder built inside the virtual computer
 *     (Vite/Astro/Next static export `dist/`, `out/`) is read and published.
 * Publishing is public → always an approval proposal first.
 */

const TEXT_EXT = /\.(html?|css|m?js|json|txt|xml|svg|webmanifest|md|map)$/i;

async function filesFromVenue(userId: string, dir: string): Promise<SiteFileInput[]> {
  const venue = await acquireVenue({ userId, purpose: 'publish-site' });
  const root = dir.replace(/\/$/, '');
  const listing = await venue.exec(
    `cd ${shq(root)} && find . -type f -size -3M ! -path '*/node_modules/*' ! -path '*/.git/*' | head -${MAX_SITE_FILES + 1}`,
    { timeoutSec: 60 }
  );
  if (listing.exitCode !== 0)
    throw new SiteError(`No se pudo leer la carpeta ${root}: ${listing.stdout.slice(0, 200)}`);
  const paths = listing.stdout
    .split('\n')
    .map((l) => l.trim().replace(/^\.\//, ''))
    .filter(Boolean);
  if (paths.length > MAX_SITE_FILES) {
    throw new SiteError(
      `La carpeta tiene más de ${MAX_SITE_FILES} archivos — publica la carpeta de build (dist/out).`
    );
  }
  const out: SiteFileInput[] = [];
  for (const rel of paths) {
    if (!normalizeSitePath(rel)) continue;
    const buf = await venue.readFileBuffer(`${root}/${rel}`, 3 * 1024 * 1024);
    out.push(
      TEXT_EXT.test(rel)
        ? { path: rel, content: buf.toString('utf8') }
        : { path: rel, content: buf.toString('base64'), encoding: 'base64' }
    );
  }
  return out;
}

registerTool({
  name: 'publishSite',
  description:
    'Publica un sitio web completo en una URL pública de UNIK (/sites/{slug}). ' +
    'Opción A: pasa `files` (index.html obligatorio + css/js/otras páginas; imágenes en base64 o por URL https). ' +
    'Opción B: construye el sitio en la computadora virtual (venueExec/venueWriteFile, p. ej. Vite → npm run build) y pasa `fromVenueDir` con la carpeta final (dist/out). ' +
    'Volver a publicar con el mismo slug actualiza el sitio. Usa HTML semántico, responsive y accesible; los scripts corren aislados (sin acceso al ERP). Requiere aprobación del usuario.',
  category: 'system',
  enabledByDefault: true,
  effect: 'external_send',
  timeoutMs: 240_000,
  parameters: z.object({
    name: z.string().min(2).max(120).describe('Nombre del sitio/negocio'),
    slug: z
      .string()
      .max(48)
      .optional()
      .describe('Dirección corta (a-z, 0-9, guiones). Default: derivada del nombre'),
    description: z.string().max(500).optional(),
    files: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .max(200)
            .describe('Ruta relativa: index.html, css/app.css, img/logo.png'),
          content: z.string().max(3_500_000),
          encoding: z.enum(['utf8', 'base64']).optional(),
        })
      )
      .max(MAX_SITE_FILES)
      .optional(),
    fromVenueDir: z
      .string()
      .max(500)
      .optional()
      .describe('Carpeta de la computadora virtual con el sitio construido'),
  }),
  summarize: (a) => {
    const p = a as { name: string; slug?: string; files?: unknown[]; fromVenueDir?: string };
    return `Publicar sitio web "${p.name}"${p.slug ? ` en /sites/${p.slug}` : ''}${p.fromVenueDir ? ` desde ${p.fromVenueDir}` : p.files ? ` (${p.files.length} archivos)` : ''}`;
  },
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as {
      name: string;
      slug?: string;
      description?: string;
      files?: SiteFileInput[];
      fromVenueDir?: string;
    };
    try {
      let files = args.files ?? [];
      if (args.fromVenueDir) {
        if (!(await isVenueEnabled()))
          return { error: 'La computadora virtual no está disponible para leer la carpeta.' };
        files = await filesFromVenue(actor.id, args.fromVenueDir);
      }
      if (files.length === 0) return { error: 'Pasa files o fromVenueDir con el sitio.' };
      const res = await publishSite({
        userId: actor.id,
        tenantId: actor.tenantId ?? null,
        agentId: ctx.agentId ?? null,
        name: args.name,
        slug: args.slug,
        description: args.description,
        files,
      });
      return {
        published: true,
        url: res.url,
        slug: res.slug,
        name: args.name,
        files: res.fileCount,
        sizeKb: Math.round(res.sizeBytes / 1024),
        updated: res.updated,
        note: 'Comparte la URL con el usuario. Para cambios, vuelve a publicar con el mismo slug.',
      };
    } catch (err) {
      if (err instanceof SiteError || err instanceof VenueUnavailableError)
        return { error: err.message };
      throw err;
    }
  },
});

registerTool({
  name: 'listSites',
  description:
    'Lista los sitios web publicados por el usuario y sus agentes (URL, estado, visitas).',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({}),
  execute: async (actor) => ({ sites: await listSites(actor.id) }),
});

registerTool({
  name: 'unpublishSite',
  description: 'Despublica (o vuelve a publicar) un sitio web del usuario por su slug.',
  category: 'system',
  enabledByDefault: true,
  effect: 'business_write',
  parameters: z.object({
    slug: z.string().min(1).max(60),
    republish: z.boolean().optional(),
  }),
  summarize: (a) => {
    const p = a as { slug: string; republish?: boolean };
    return `${p.republish ? 'Volver a publicar' : 'Despublicar'} el sitio /sites/${p.slug}`;
  },
  execute: async (actor, args) => {
    const { slug, republish } = args as { slug: string; republish?: boolean };
    const ok = await setSiteStatus(actor.id, slug, republish ? 'published' : 'unpublished');
    return ok
      ? { ok: true, slug, status: republish ? 'published' : 'unpublished' }
      : { error: 'Sitio no encontrado' };
  },
});
