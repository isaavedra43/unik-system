'use client';

import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSearch, HelpCircle, Search, Send } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { api, categoryLabel, errorMessage, type Hit, type ShareableResult } from './knowledge-api';

const MATCH_LABEL: Record<NonNullable<Hit['match']>, string> = {
  lexical: 'Palabras exactas',
  semantic: 'Por significado',
  hybrid: 'Palabras y significado',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.split(/\s+/).filter((t) => t.length >= 3).map(escapeRegExp);
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  );
}

export function SearchTester({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [visibility, setVisibility] = useState<'' | 'publishable'>('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searched, setSearched] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [request, setRequest] = useState('');
  const [share, setShare] = useState<ShareableResult | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    try {
      const params = new URLSearchParams({ q: query.trim() });
      if (visibility) params.set('visibility', visibility);
      const r = await api<{ hits: Hit[] }>(`/app/assistant/api/knowledge/search?${params.toString()}`);
      setHits(r.hits);
      setSearched(query.trim());
    } catch (e) {
      setSearchError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  async function runShare(event: React.FormEvent) {
    event.preventDefault();
    setSharing(true);
    setShareError(null);
    try {
      setShare(await api<ShareableResult>(`/app/admin/knowledge/api/shareable?q=${encodeURIComponent(request.trim())}`));
    } catch (e) {
      setShareError(errorMessage(e));
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="klib-test">
      <section className="klib-card klib-section">
        <h3 className="klib-section-title">
          <FileSearch size={16} aria-hidden="true" /> ¿Con qué respondería la IA?
        </h3>
        <p className="klib-section-desc">Escribe una pregunta como la haría alguien del equipo o un cliente. Verás los fragmentos aprobados que la IA usaría y de qué fuente salen.</p>
        <form className="klib-stack" onSubmit={runSearch}>
          <div className="klib-inline-form">
            <label className="klib-search">
              <Search size={16} aria-hidden="true" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="¿Cuánto dura la garantía de instalación?" aria-label="Pregunta" />
            </label>
            <Button type="submit" isLoading={searching} disabled={query.trim().length < 2}>
              Buscar
            </Button>
          </div>
          <select className="klib-select" value={visibility} onChange={(e) => setVisibility(e.target.value as '' | 'publishable')} aria-label="Para quién es la respuesta">
            <option value="">Respuesta para el equipo (interno y publicable)</option>
            <option value="publishable">Respuesta para un cliente (solo publicable)</option>
          </select>
        </form>

        {searchError && (
          <div className="klib-note klib-note-danger" role="alert">
            <AlertTriangle size={16} />
            <div className="klib-note-body">{searchError}</div>
          </div>
        )}

        {hits && (
          <div className="klib-results" aria-live="polite">
            {hits.length === 0 ? (
              <div className="klib-note klib-note-warning">
                <HelpCircle size={16} />
                <div className="klib-note-body">
                  <strong>Sin coincidencias.</strong> La IA diría que no tiene esa información en lugar de inventarla. Sube o aprueba el documento que la contiene.
                </div>
              </div>
            ) : (
              hits.map((h, i) => (
                <article key={`${h.sourceId}-${i}`} className="klib-hit">
                  <div className="klib-hit-head">
                    <button type="button" className="klib-link" onClick={() => onOpen(h.sourceId)}>
                      {h.title}
                    </button>
                    <span className="klib-sub">v{h.version}{h.section ? ` · ${h.section}` : ''}</span>
                    <Badge variant={h.visibility === 'publishable' ? 'info' : 'weak'}>{h.visibility === 'publishable' ? 'Publicable' : 'Interna'}</Badge>
                    {h.match && <Badge variant="default">{MATCH_LABEL[h.match]}</Badge>}
                  </div>
                  <p className="klib-excerpt">
                    <Highlight text={h.excerpt} query={searched} />
                  </p>
                </article>
              ))
            )}
          </div>
        )}
      </section>

      <section className="klib-card klib-section">
        <h3 className="klib-section-title">
          <Send size={16} aria-hidden="true" /> ¿Qué archivo mandaría?
        </h3>
        <p className="klib-section-desc">Pide un archivo como se lo pedirías a la IA. Solo elige entre los aprobados, publicables y vigentes.</p>
        <form className="klib-inline-form" onSubmit={runShare}>
          <input className="klib-input" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="mándale el PDF de promociones" aria-label="Pedido" />
          <Button type="submit" isLoading={sharing} disabled={request.trim().length < 2}>
            Probar
          </Button>
        </form>

        {shareError && (
          <div className="klib-note klib-note-danger" role="alert">
            <AlertTriangle size={16} />
            <div className="klib-note-body">{shareError}</div>
          </div>
        )}

        {share && (
          <div className="klib-results" aria-live="polite">
            {share.decision === 'single' && (
              <div className="klib-note klib-note-success">
                <CheckCircle2 size={16} />
                <div className="klib-note-body">
                  <strong>Mandaría “{share.matches[0].title}”</strong> ({share.matches[0].fileName}, v{share.matches[0].version}).
                </div>
              </div>
            )}
            {share.decision === 'ambiguous' && (
              <div className="klib-note klib-note-warning">
                <HelpCircle size={16} />
                <div className="klib-note-body">
                  <strong>Preguntaría cuál.</strong> Hay varios parecidos; agrega “Cuándo usarlo” o etiquetas distintas para que elija solo.
                </div>
              </div>
            )}
            {share.decision === 'none' && (
              <div className="klib-note klib-note-warning">
                <AlertTriangle size={16} />
                <div className="klib-note-body">
                  <strong>No mandaría nada.</strong>{' '}
                  {share.totalShareable === 0 ? 'Todavía no hay archivos publicables aprobados.' : `Ninguno de los ${share.totalShareable} archivos autorizados coincide.`}
                </div>
              </div>
            )}
            {share.matches.map((m, i) => (
              <article key={m.knowledgeSourceId} className="klib-hit">
                <div className="klib-hit-head">
                  <button type="button" className="klib-link" onClick={() => onOpen(m.knowledgeSourceId)}>
                    {m.title}
                  </button>
                  {i === 0 && share.decision === 'single' && <Badge variant="success">Elegido</Badge>}
                  {m.category && <Badge variant="weak">{categoryLabel(m.category)}</Badge>}
                  <span className="klib-sub">{m.fileName}</span>
                </div>
                {m.useWhen && <p className="klib-excerpt">{m.useWhen}</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
