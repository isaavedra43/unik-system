'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Pencil } from 'lucide-react';
import { Button, Input } from '@/components/ui/primitives';
import {
  getFileAccessUrl,
  uploadFile,
  UploadError,
  type UploadProgress,
} from '@/lib/upload-client';
import type { ImageBlock } from '@/modules/studio/studio-content';
import { StudioImageEditor } from './StudioImageEditor';

interface Props {
  block: ImageBlock;
  documentId: string;
  readOnly: boolean;
  onChange: (next: ImageBlock) => void;
}

const ACCEPT = 'image/png,image/jpeg,image/webp';

/** Image block: upload through the storage pipeline (target studio_document), preview, edit. */
export function StudioImageBlockEditor({ block, documentId, readOnly, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    if (!block.storageObjectId) return;
    getFileAccessUrl(block.storageObjectId, 'inline')
      .then((res) => {
        if (!cancelled) setPreviewUrl(res.url);
      })
      .catch(() => {
        if (!cancelled) setError('No se pudo cargar la vista previa');
      });
    return () => {
      cancelled = true;
    };
  }, [block.storageObjectId]);

  async function upload(file: File) {
    setError(null);
    setProgress(null);
    try {
      const result = await uploadFile(file, {
        target: { type: 'studio_document', id: documentId },
        onProgress: setProgress,
      });
      onChange({
        ...block,
        storageObjectId: result.objectId,
        alt: block.alt || file.name.replace(/\.[^.]+$/, ''),
      });
    } catch (err) {
      setError(err instanceof UploadError ? err.message : 'No se pudo subir la imagen');
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {block.storageObjectId ? (
        previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={block.alt || 'Imagen del documento'}
            style={{
              maxWidth: '100%',
              maxHeight: 360,
              borderRadius: 6,
              border: '1px solid var(--unik-border)',
            }}
          />
        ) : (
          <div className="text-muted text-small">Cargando vista previa…</div>
        )
      ) : (
        <div className="text-muted text-small">
          Sin imagen. Sube un PNG, JPEG o WebP (máx. 20 MB).
        </div>
      )}
      {progress ? (
        <div className="text-small" role="status">
          {progress.phase === 'validating' ? 'Validando…' : `Subiendo ${progress.percent}%`}
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {!readOnly ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<ImagePlus size={14} />}
            onClick={() => inputRef.current?.click()}
            disabled={Boolean(progress)}
          >
            {block.storageObjectId ? 'Reemplazar imagen' : 'Subir imagen'}
          </Button>
          {block.storageObjectId ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Pencil size={14} />}
              onClick={() => setEditing(true)}
              disabled={Boolean(progress)}
            >
              Editar (recortar, rotar, anotar)
            </Button>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Input
          aria-label="Texto alternativo"
          placeholder="Descripción (texto alternativo)"
          value={block.alt}
          maxLength={300}
          disabled={readOnly}
          onChange={(e) => onChange({ ...block, alt: e.target.value })}
          style={{ flex: '1 1 200px' }}
        />
        <Input
          aria-label="Pie de imagen"
          placeholder="Pie de imagen (opcional)"
          value={block.caption ?? ''}
          maxLength={500}
          disabled={readOnly}
          onChange={(e) => onChange({ ...block, caption: e.target.value })}
          style={{ flex: '1 1 200px' }}
        />
      </div>
      {editing && block.storageObjectId ? (
        <StudioImageEditor
          documentId={documentId}
          sourceObjectId={block.storageObjectId}
          onClose={() => setEditing(false)}
          onSaved={(objectId) => {
            setEditing(false);
            onChange({ ...block, storageObjectId: objectId });
          }}
        />
      ) : null}
    </div>
  );
}
