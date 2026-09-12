'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, RefreshCw } from 'lucide-react';
import { Button, Spinner } from '@/components/ui/primitives';
import { Drawer } from '@/components/ui/composite';
import { getFileAccessUrl } from '@/lib/upload-client';
import {
  formatDateTime,
  statusBadgeClass,
  studioApi,
  StudioApiError,
  type StudioExportDTO,
  type StudioExportFormat,
} from './studio-client';

interface Props {
  open: boolean;
  documentId: string;
  dirty: boolean;
  onClose: () => void;
}

const FORMATS: Array<{ format: StudioExportFormat; label: string; hint: string }> = [
  { format: 'pdf', label: 'PDF', hint: 'Documento paginado con marca' },
  { format: 'docx', label: 'Word', hint: 'Editable en Word' },
  { format: 'xlsx', label: 'Excel', hint: 'Una hoja por tabla + resumen' },
  { format: 'csv', label: 'CSV', hint: 'Tablas e indicadores' },
  { format: 'pptx', label: 'PowerPoint', hint: 'Una diapositiva por sección' },
  { format: 'html', label: 'HTML', hint: 'Página autocontenida' },
  { format: 'md', label: 'Markdown', hint: 'Texto con tablas' },
  { format: 'svg', label: 'Imagen (SVG)', hint: 'Imagen del documento' },
];

/**
 * Export menu: launches an export per format and shows every export with its
 * verification result. The download link appears ONLY when the export is
 * `ready` (rendered, reopened and verified).
 */
export function StudioExportMenu({ open, documentId, dirty, onClose }: Props) {
  const [exports, setExports] = useState<StudioExportDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<StudioExportFormat | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setExports(await studioApi.listExports(documentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las exportaciones');
    }
  }, [documentId]);

  useEffect(() => {
    if (!open) return;
    setExports(null);
    setError(null);
    void load();
  }, [open, load]);

  // Poll while something is still processing.
  useEffect(() => {
    if (!open || !exports?.some((e) => e.status === 'processing')) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [open, exports, load]);

  async function request(format: StudioExportFormat) {
    setRequesting(format);
    setError(null);
    try {
      const result = await studioApi.requestExport(documentId, format);
      setExports((list) => [result, ...(list ?? []).filter((e) => e.id !== result.id)]);
      setExpanded(result.id);
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'No se pudo exportar');
    } finally {
      setRequesting(null);
    }
  }

  async function download(exp: StudioExportDTO) {
    if (!exp.storageObjectId) return;
    try {
      const access = await getFileAccessUrl(exp.storageObjectId, 'attachment');
      window.open(access.url, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo autorizar la descarga');
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Exportar"
      subtitle="Cada archivo se reabre y verifica antes de entregarse."
      size="lg"
    >
      {dirty ? (
        <div className="alert alert-warning">
          Tienes cambios sin guardar: se exportará la última versión guardada.
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <div
        className="grid-2"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: '0.5rem',
          marginBottom: '1rem',
        }}
      >
        {FORMATS.map((f) => (
          <Button
            key={f.format}
            variant="secondary"
            size="sm"
            isLoading={requesting === f.format}
            disabled={requesting !== null}
            onClick={() => request(f.format)}
            title={f.hint}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <strong>Exportaciones</strong>
        <button
          type="button"
          className="icon-btn"
          aria-label="Actualizar exportaciones"
          onClick={() => load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {!exports && !error ? (
        <div className="assistant-admin-loading">
          <Spinner /> Cargando…
        </div>
      ) : null}
      {exports && exports.length === 0 ? (
        <p className="text-muted">Aún no hay exportaciones de este documento.</p>
      ) : null}
      {exports ? (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          {exports.map((exp) => {
            const failedChecks = exp.verification?.checks.filter((c) => !c.ok) ?? [];
            const figures = exp.verification?.checks.find((c) => c.name === 'figures');
            return (
              <li key={exp.id} className="card card-compact">
                <div
                  style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <strong>{exp.formatLabel}</strong>
                  <span className={statusBadgeClass(exp.status)}>
                    {exp.status === 'ready'
                      ? 'Listo'
                      : exp.status === 'failed'
                        ? 'Falló'
                        : 'Procesando'}
                  </span>
                  <span className="text-muted text-small">{formatDateTime(exp.createdAt)}</span>
                  {exp.status === 'processing' ? <Spinner size={14} /> : null}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                    {exp.verification ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpanded(expanded === exp.id ? null : exp.id)}
                      >
                        {expanded === exp.id ? 'Ocultar verificación' : 'Ver verificación'}
                      </Button>
                    ) : null}
                    {exp.status === 'ready' && exp.storageObjectId ? (
                      <Button size="sm" icon={<Download size={14} />} onClick={() => download(exp)}>
                        Descargar
                      </Button>
                    ) : null}
                  </div>
                </div>
                {exp.status === 'ready' && exp.verification?.ok ? (
                  <div
                    className="text-small"
                    style={{
                      marginTop: '0.35rem',
                      display: 'flex',
                      gap: '0.35rem',
                      alignItems: 'center',
                    }}
                  >
                    <CheckCircle2 size={14} aria-hidden="true" /> Verificado
                    {figures ? ` · ${figures.detail}` : ''}
                  </div>
                ) : null}
                {exp.status === 'failed' ? (
                  <div className="alert alert-error" style={{ marginTop: '0.35rem' }}>
                    <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
                      <AlertCircle size={14} aria-hidden="true" />{' '}
                      {exp.error ?? 'La exportación falló'}
                    </span>
                    {failedChecks.length > 0 ? (
                      <ul style={{ margin: '0.35rem 0 0 1rem' }}>
                        {failedChecks.map((c) => (
                          <li key={c.name}>
                            <strong>{c.name}</strong>: {c.detail}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="text-small" style={{ marginTop: '0.25rem' }}>
                      No se entrega ningún enlace de descarga cuando la verificación falla.
                    </div>
                  </div>
                ) : null}
                {expanded === exp.id && exp.verification ? (
                  <ul className="text-small" style={{ margin: '0.5rem 0 0 1rem' }}>
                    {exp.verification.checks.map((c) => (
                      <li key={c.name} style={{ color: c.ok ? undefined : 'var(--unik-danger)' }}>
                        {c.ok ? '✓' : '✗'} <strong>{c.name}</strong>: {c.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-muted text-small" style={{ marginTop: '1rem' }}>
        La exportación a PNG queda pendiente de un rasterizador en el servidor; usa SVG o PDF
        mientras tanto.
      </p>
    </Drawer>
  );
}
