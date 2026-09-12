'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, RotateCw, Type, Undo2 } from 'lucide-react';
import { Button, Input } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/composite';
import { uploadFile, UploadError } from '@/lib/upload-client';

/**
 * Basic client-side image editor: crop (drag a rectangle), rotate 90° and
 * text annotations (click to place). Every operation is rendered with
 * <canvas>; saving exports a PNG that is uploaded as a NEW object through the
 * regular storage pipeline (target studio_document). The original object is
 * never modified — the document version keeps the history.
 */

interface Props {
  documentId: string;
  sourceObjectId: string;
  onClose: () => void;
  onSaved: (objectId: string) => void;
}

interface Annotation {
  x: number;
  y: number;
  text: string;
  size: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_HISTORY = 10;

export function StudioImageEditor({ documentId, sourceObjectId, onClose, onSaved }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<ImageBitmap | HTMLImageElement | null>(null);
  const [history, setHistory] = useState<Array<ImageBitmap | HTMLImageElement>>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [mode, setMode] = useState<'none' | 'crop' | 'text'>('none');
  const [text, setText] = useState('');
  const [fontSize, setFontSize] = useState(28);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the source through the authenticated same-origin stream so the canvas is not tainted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/app/files/api/objects/${encodeURIComponent(sourceObjectId)}/content`
        );
        if (!res.ok) throw new Error('No se pudo leer la imagen');
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        if (!cancelled) setBase(bitmap);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'No se pudo cargar la imagen');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceObjectId]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    for (const a of annotations) {
      ctx.font = `bold ${a.size}px Helvetica, Arial, sans-serif`;
      ctx.lineWidth = Math.max(2, a.size / 8);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.fillStyle = '#dc2626';
      ctx.strokeText(a.text, a.x, a.y);
      ctx.fillText(a.text, a.x, a.y);
    }
    if (drag && mode === 'crop') {
      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = Math.max(2, canvas.width / 300);
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(drag.x, drag.y, drag.w, drag.h);
      ctx.restore();
    }
  }, [annotations, base, drag, mode]);

  useEffect(() => {
    draw();
  }, [draw]);

  function pushHistory(previous: ImageBitmap | HTMLImageElement) {
    setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), previous]);
  }

  /** Bakes the current canvas (image + annotations) into a new base bitmap. */
  async function bake(transform: (src: HTMLCanvasElement) => HTMLCanvasElement): Promise<void> {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    draw();
    const next = transform(canvas);
    const bitmap = await createImageBitmap(next);
    pushHistory(base);
    setBase(bitmap);
    setAnnotations([]);
    setDrag(null);
  }

  async function rotate() {
    await bake((src) => {
      const out = document.createElement('canvas');
      out.width = src.height;
      out.height = src.width;
      const ctx = out.getContext('2d')!;
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
      return out;
    });
  }

  async function applyCrop() {
    if (!drag || drag.w < 4 || drag.h < 4) return;
    const rect = normalizeRect(drag);
    await bake((src) => {
      const out = document.createElement('canvas');
      out.width = Math.round(rect.w);
      out.height = Math.round(rect.h);
      out
        .getContext('2d')!
        .drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height);
      return out;
    });
    setMode('none');
  }

  function undo() {
    setHistory((h) => {
      const previous = h[h.length - 1];
      if (previous) {
        setBase(previous);
        setAnnotations([]);
        setDrag(null);
      }
      return h.slice(0, -1);
    });
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!base) return;
    const p = canvasPoint(e);
    if (mode === 'crop') {
      setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (mode === 'text' && text.trim()) {
      setAnnotations((a) => [...a, { x: p.x, y: p.y, text: text.trim(), size: fontSize }]);
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== 'crop' || !drag || e.buttons === 0) return;
    const p = canvasPoint(e);
    setDrag({ x: drag.x, y: drag.y, w: p.x - drag.x, h: p.y - drag.y });
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    setSaving(true);
    setError(null);
    try {
      setDrag(null);
      draw();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('No se pudo generar el PNG');
      const result = await uploadFile(blob, {
        target: { type: 'studio_document', id: documentId },
        fileName: 'imagen-editada.png',
        mimeType: 'image/png',
      });
      onSaved(result.objectId);
    } catch (err) {
      setError(
        err instanceof UploadError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'No se pudo guardar'
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Editar imagen"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} isLoading={saving} disabled={!base}>
            Guardar como nueva versión
          </Button>
        </>
      }
    >
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? <p className="text-muted">Cargando imagen…</p> : null}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <Button
          size="sm"
          variant="secondary"
          icon={<RotateCw size={14} />}
          onClick={rotate}
          disabled={!base || saving}
        >
          Rotar 90°
        </Button>
        <Button
          size="sm"
          variant={mode === 'crop' ? 'primary' : 'secondary'}
          icon={<Crop size={14} />}
          onClick={() => setMode(mode === 'crop' ? 'none' : 'crop')}
          disabled={!base || saving}
        >
          Recortar
        </Button>
        {mode === 'crop' ? (
          <Button
            size="sm"
            onClick={applyCrop}
            disabled={!drag || Math.abs(drag.w) < 4 || Math.abs(drag.h) < 4}
          >
            Aplicar recorte
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={mode === 'text' ? 'primary' : 'secondary'}
          icon={<Type size={14} />}
          onClick={() => setMode(mode === 'text' ? 'none' : 'text')}
          disabled={!base || saving}
        >
          Anotar texto
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 size={14} />}
          onClick={undo}
          disabled={history.length === 0 || saving}
        >
          Deshacer
        </Button>
      </div>
      {mode === 'text' ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          <Input
            aria-label="Texto de la anotación"
            placeholder="Texto; luego haz clic en la imagen"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={120}
            style={{ flex: '1 1 200px' }}
          />
          <Input
            aria-label="Tamaño de letra"
            type="number"
            min={10}
            max={120}
            value={fontSize}
            onChange={(e) => setFontSize(Math.max(10, Math.min(120, Number(e.target.value) || 28)))}
            style={{ width: 90 }}
          />
        </div>
      ) : null}
      {mode === 'crop' ? (
        <p className="text-muted text-small">Arrastra sobre la imagen para dibujar el recorte.</p>
      ) : null}
      <div
        style={{
          overflow: 'auto',
          maxHeight: '60vh',
          border: '1px solid var(--unik-border)',
          borderRadius: 6,
        }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Lienzo de edición"
          style={{
            maxWidth: '100%',
            display: 'block',
            cursor: mode === 'none' ? 'default' : 'crosshair',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        />
      </div>
      <p className="text-muted text-small" style={{ marginTop: '0.5rem' }}>
        El resultado se sube como PNG nuevo; la imagen original se conserva en las versiones
        anteriores.
      </p>
    </Modal>
  );
}

function normalizeRect(r: Rect): Rect {
  const x = r.w < 0 ? r.x + r.w : r.x;
  const y = r.h < 0 ? r.y + r.h : r.y;
  return { x: Math.max(0, x), y: Math.max(0, y), w: Math.abs(r.w), h: Math.abs(r.h) };
}
