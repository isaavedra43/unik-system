'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink,
  FileText,
  Globe,
  Image as ImageIcon,
  Link2,
  Loader2,
  Rocket,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ArtifactInfo } from '../lib/types';
import { hostOf, timeAgo } from '../lib/format';
import { ArtifactCard } from '../cards/ArtifactCard';

/**
 * "Archivos": everything the agents produced in this conversation (documents,
 * spreadsheets, charts), the websites they published, the images/videos they
 * generated and the sources they read.
 */

export interface MediaEntry {
  url: string;
  medium: string;
  ts: number;
}
export interface PageEntry {
  url: string;
  title?: string | null;
  snippet?: string | null;
  ts: number;
}
interface SiteRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  status: string;
  fileCount: number;
  visits: number;
  url: string;
  updatedAt: string;
}

export function FilesView({
  conversationId,
  artifacts,
  media,
  pages,
  visible,
  siteBump,
}: {
  conversationId: string | null;
  /** Artifacts seen in the thread (persisted + live). */
  artifacts: ArtifactInfo[];
  media: MediaEntry[];
  pages: PageEntry[];
  visible: boolean;
  /** Bumped when an agent publishes a site. */
  siteBump: number;
}) {
  const [listed, setListed] = useState<ArtifactInfo[] | null>(null);
  const [sites, setSites] = useState<SiteRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !conversationId) {
      setListed(null);
      return;
    }
    let alive = true;
    fetch(`/app/assistant/api/artifacts?conversationId=${encodeURIComponent(conversationId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { artifacts?: Array<Record<string, unknown>> } | null) => {
        if (!alive) return;
        setListed(
          (d?.artifacts ?? []).map((a) => {
            const meta = (a.meta && typeof a.meta === 'object' ? a.meta : {}) as Record<
              string,
              unknown
            >;
            const id = String(a.id);
            const type = (
              ['pdf', 'xlsx', 'docx', 'csv', 'table', 'chart', 'image'].includes(String(a.type))
                ? a.type
                : 'pdf'
            ) as ArtifactInfo['type'];
            return {
              artifactId: id,
              type,
              title: String(meta.title ?? meta.filename ?? 'Archivo'),
              filename: typeof meta.filename === 'string' ? meta.filename : undefined,
              downloadUrl: a.hasFile ? `/app/assistant/api/artifacts/${id}/download` : undefined,
              sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : undefined,
              rowCount: typeof meta.rowCount === 'number' ? meta.rowCount : undefined,
              pageCount: typeof meta.pageCount === 'number' ? meta.pageCount : undefined,
              createdAt: typeof a.createdAt === 'string' ? a.createdAt : undefined,
            } satisfies ArtifactInfo;
          })
        );
      })
      .catch(() => alive && setListed([]));
    return () => {
      alive = false;
    };
  }, [conversationId, visible, artifacts.length]);

  const loadSites = useCallback(async () => {
    try {
      const r = await fetch('/app/assistant/api/sites');
      const d = (await r.json().catch(() => ({}))) as { sites?: SiteRow[] };
      setSites(d.sites ?? []);
    } catch {
      setSites([]);
    }
  }, []);
  useEffect(() => {
    if (visible) void loadSites();
  }, [visible, siteBump, loadSites]);

  const toggleSite = async (s: SiteRow) => {
    setBusy(s.slug);
    try {
      const r = await fetch('/app/assistant/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: s.slug,
          status: s.status === 'published' ? 'unpublished' : 'published',
        }),
      });
      if (!r.ok) throw new Error('No se pudo actualizar el sitio');
      toast.success(s.status === 'published' ? 'Sitio fuera de línea' : 'Sitio publicado de nuevo');
      await loadSites();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
    } finally {
      setBusy(null);
    }
  };

  // Merge persisted + live without duplicates (newest first).
  const merged = new Map<string, ArtifactInfo>();
  for (const a of [...artifacts, ...(listed ?? [])])
    if (!merged.has(a.artifactId)) merged.set(a.artifactId, a);
  const files = [...merged.values()].reverse();
  const uniqPages = [...new Map(pages.map((p) => [p.url, p] as const)).values()].slice(0, 20);
  const nothing =
    files.length === 0 &&
    media.length === 0 &&
    uniqPages.length === 0 &&
    (sites?.length ?? 0) === 0;

  return (
    <div className="uv-ws-scroll">
      {nothing && (
        <div className="uv-empty">
          <FileText size={24} />
          <span className="uv-empty-title">Aquí aparece todo lo que produzcan</span>
          <span>
            Reportes en PDF y Excel, cotizaciones, gráficas, imágenes, sitios web publicados y las
            fuentes que consultaron.
          </span>
        </div>
      )}

      {files.length > 0 && (
        <section className="uv-block">
          <div className="uv-block-head">
            <FileText size={14} />
            <span>Documentos de esta conversación</span>
            <span className="uv-count">{files.length}</span>
          </div>
          <div className="uv-cards">
            {files.map((a) => (
              <ArtifactCard key={a.artifactId} artifact={{ ...a, inlineRender: false }} />
            ))}
          </div>
        </section>
      )}

      {sites && sites.length > 0 && (
        <section className="uv-block">
          <div className="uv-block-head">
            <Rocket size={14} />
            <span>Sitios publicados</span>
          </div>
          {sites.map((s) => (
            <div key={s.id} className="uv-link-card">
              <Globe size={16} />
              <div>
                <strong>{s.name}</strong>
                <span>
                  {s.status === 'published'
                    ? hostOf(s.url) + new URL(s.url, 'https://x').pathname
                    : 'Fuera de línea'}{' '}
                  · {s.visits} visitas · {timeAgo(s.updatedAt)}
                </span>
              </div>
              {s.status === 'published' && (
                <a
                  className="uv-icon-btn is-sm"
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Abrir ${s.name}`}
                >
                  <ExternalLink size={14} />
                </a>
              )}
              <button
                type="button"
                className="uv-btn is-ghost is-sm"
                onClick={() => void toggleSite(s)}
                disabled={busy === s.slug}
              >
                {busy === s.slug ? <Loader2 size={13} className="uv-spin" /> : null}
                {s.status === 'published' ? 'Despublicar' : 'Publicar'}
              </button>
            </div>
          ))}
        </section>
      )}

      {media.length > 0 && (
        <section className="uv-block">
          <div className="uv-block-head">
            <ImageIcon size={14} />
            <span>Imágenes y videos</span>
          </div>
          <div className="uv-media-grid">
            {media.slice(0, 12).map((m) =>
              m.medium === 'video' ? (
                <video key={m.url} src={m.url} controls preload="metadata" />
              ) : (
                <a key={m.url} href={m.url} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url} alt="Imagen generada por el agente" loading="lazy" />
                </a>
              )
            )}
          </div>
        </section>
      )}

      {uniqPages.length > 0 && (
        <section className="uv-block">
          <div className="uv-block-head">
            <Link2 size={14} />
            <span>Fuentes consultadas</span>
          </div>
          {uniqPages.map((p) => (
            <a
              key={p.url}
              className="uv-link-card"
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="uv-favicon">{hostOf(p.url).slice(0, 1)}</span>
              <div>
                <strong>{p.title || hostOf(p.url)}</strong>
                <span>{p.snippet || hostOf(p.url)}</span>
              </div>
              <ExternalLink size={14} />
            </a>
          ))}
        </section>
      )}
    </div>
  );
}
