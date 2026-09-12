'use client';

import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button, Spinner } from '@/components/ui/primitives';
import { Drawer } from '@/components/ui/composite';
import {
  formatDateTime,
  studioApi,
  StudioApiError,
  type SaveDocumentResult,
  type StudioVersionDTO,
} from './studio-client';

interface Props {
  open: boolean;
  documentId: string;
  canEdit: boolean;
  onClose: () => void;
  onRestored: (result: SaveDocumentResult) => void;
}

/** Version history. Restoring creates a NEW version with the old content. */
export function StudioVersionsPanel({ open, documentId, canEdit, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<StudioVersionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setError(null);
    studioApi
      .listVersions(documentId)
      .then(setVersions)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'No se pudieron cargar las versiones')
      );
  }, [open, documentId]);

  async function restore(version: StudioVersionDTO) {
    if (
      !window.confirm(
        `¿Restaurar la versión ${version.version}? Se creará una nueva versión con ese contenido.`
      )
    )
      return;
    setRestoring(version.id);
    setError(null);
    try {
      onRestored(await studioApi.restoreVersion(documentId, version.id));
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'No se pudo restaurar');
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Versiones"
      subtitle="Cada guardado crea una versión; nada se sobrescribe."
    >
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {!versions && !error ? (
        <div className="assistant-admin-loading">
          <Spinner /> Cargando…
        </div>
      ) : null}
      {versions ? (
        <ul className="assistant-admin-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {versions.map((v) => (
            <li
              key={v.id}
              className="assistant-admin-list-item"
              style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}
            >
              <div style={{ flex: '1 1 200px' }}>
                <div className="assistant-admin-list-name">
                  Versión {v.version}{' '}
                  {v.isCurrent ? <span className="badge badge-info">actual</span> : null}{' '}
                  {v.isApproved ? <span className="badge badge-success">aprobada</span> : null}
                </div>
                <div className="assistant-admin-list-meta">
                  {formatDateTime(v.createdAt)} · {v.createdByName ?? v.createdBy}
                </div>
                {v.changeSummary ? <div className="text-small">{v.changeSummary}</div> : null}
                <div className="text-muted text-small mono" title="Hash del contenido">
                  {v.contentHash.slice(0, 12)}
                </div>
              </div>
              {canEdit && !v.isCurrent ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RotateCcw size={14} />}
                  isLoading={restoring === v.id}
                  onClick={() => restore(v)}
                >
                  Restaurar
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}
