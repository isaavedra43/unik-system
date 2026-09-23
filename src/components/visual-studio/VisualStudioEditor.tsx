'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadFile } from '@/lib/upload-client';
import type {
  SurfacePromptSpec,
  VisualAssetDTO,
  VisualMode,
  VisualProposalDTO,
  VisualSurfaceDTO,
} from '@/modules/visual-studio/visual-contract';

/**
 * Editor de Visual Studio: lienzo con la foto del cliente, herramientas de
 * selección (clic +/-, caja, pincel, borrador), catálogo de productos UNIK y
 * panel de propuestas con comparador antes/después.
 */

type Tool = 'add' | 'remove' | 'box' | 'brush' | 'eraser';

interface ProductItem {
  id: string;
  name: string | null;
  sku: string | null;
  rate: string | null;
  unit: string | null;
  mediaCount: number;
}

interface ProductMediaItem {
  id: string;
  contentUrl: string;
  label: string | null;
  kind: string;
}

interface Props {
  projectId: string;
  initialAssets: VisualAssetDTO[];
  initialSurfaces: VisualSurfaceDTO[];
  initialProposals: VisualProposalDTO[];
  canEdit: boolean;
  canGenerate: boolean;
  canSelect: boolean;
  samConfigured: boolean;
}

const SURFACE_COLORS = ['#e0503c', '#2f7dd1', '#3c9a5f', '#b8860b', '#7a4fd0', '#c2457e'];

function surfaceColor(index: number): string {
  return SURFACE_COLORS[index % SURFACE_COLORS.length];
}

export function VisualStudioEditor({
  projectId,
  initialAssets,
  initialSurfaces,
  initialProposals,
  canEdit,
  canGenerate,
  canSelect,
  samConfigured,
}: Props) {
  const [assets, setAssets] = useState(initialAssets);
  const [surfaces, setSurfaces] = useState(initialSurfaces);
  const [proposals, setProposals] = useState(initialProposals);
  const [assetId, setAssetId] = useState(initialAssets.find((a) => a.kind === 'source')?.id ?? initialAssets[0]?.id ?? '');
  const [surfaceId, setSurfaceId] = useState('');
  const [tool, setTool] = useState<Tool>('add');
  const [points, setPoints] = useState<Array<{ x: number; y: number; positive: boolean }>>([]);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [newSurfaceLabel, setNewSurfaceLabel] = useState('');

  const [productQuery, setProductQuery] = useState('');
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [productId, setProductId] = useState('');
  const [productMedia, setProductMedia] = useState<ProductMediaItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<VisualMode>('faithful');
  const [compareId, setCompareId] = useState<string | null>(null);
  const [slider, setSlider] = useState(50);

  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushDirty = useRef(false);
  const drawing = useRef(false);
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ x: number; y: number } | null>(null);
  const panning = useRef(false);

  const asset = assets.find((a) => a.id === assetId) ?? null;
  const assetSurfaces = useMemo(
    () => surfaces.filter((s) => s.assetId === assetId),
    [surfaces, assetId]
  );
  const surface = surfaces.find((s) => s.id === surfaceId) ?? null;
  const compareProposal = proposals.find((p) => p.id === compareId && p.resultUrl) ?? null;

  // ------------------------------------------------------------------ data

  const refresh = useCallback(async () => {
    const res = await fetch(`/app/visual-studio/api/projects/${projectId}`);
    if (!res.ok) return;
    const data = await res.json();
    setAssets(data.assets);
    setSurfaces(data.surfaces);
    setProposals(data.proposals);
  }, [projectId]);

  // Poll mientras haya generaciones en curso.
  useEffect(() => {
    if (!proposals.some((p) => p.status === 'pending' || p.status === 'processing')) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [proposals, refresh]);

  // Catálogo
  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await fetch(
        `/app/visual-studio/api/products?search=${encodeURIComponent(productQuery)}`
      );
      if (res.ok) setProducts((await res.json()).products);
    }, 250);
    return () => clearTimeout(t);
  }, [productQuery]);

  useEffect(() => {
    if (!productId) {
      setProductMedia([]);
      return;
    }
    void fetch(`/app/visual-studio/api/products/${productId}/media`)
      .then((r) => (r.ok ? r.json() : { media: [] }))
      .then((d) => setProductMedia(d.media));
  }, [productId]);

  // ------------------------------------------------------------- coordenadas

  /** Punto del evento → coordenadas en píxeles de la imagen original. */
  function toImageCoords(e: React.MouseEvent): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * img.naturalWidth;
    const y = ((e.clientY - rect.top) / rect.height) * img.naturalHeight;
    if (x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) return null;
    return { x, y };
  }

  function syncOverlaySize() {
    const img = imgRef.current;
    const cv = overlayRef.current;
    if (!img || !cv) return;
    if (cv.width !== img.naturalWidth || cv.height !== img.naturalHeight) {
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
    }
  }

  // Canvas de trabajo del pincel, a resolución de imagen.
  function brushCanvas(): HTMLCanvasElement {
    const img = imgRef.current;
    if (!brushCanvasRef.current && img) {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      brushCanvasRef.current = c;
    }
    return brushCanvasRef.current!;
  }

  // ---------------------------------------------------------------- overlay

  const redrawOverlay = useCallback(async () => {
    const cv = overlayRef.current;
    const img = imgRef.current;
    if (!cv || !img || !img.complete || img.naturalWidth === 0) return;
    syncOverlaySize();
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);

    // Máscaras de superficies de este asset, teñidas por color.
    for (const s of assetSurfaces) {
      // Si la superficie activa tiene edición de pincel pendiente, se dibuja
      // desde el canvas de trabajo en vez de la máscara guardada.
      let maskSource: HTMLImageElement | HTMLCanvasElement;
      if (s.id === surfaceId && brushDirty.current && brushCanvasRef.current) {
        maskSource = brushCanvasRef.current;
      } else {
        const maskImg = new Image();
        maskImg.crossOrigin = 'same-origin';
        await new Promise<void>((resolve) => {
          maskImg.onload = () => resolve();
          maskImg.onerror = () => resolve();
          maskImg.src = s.maskUrl;
        });
        if (!maskImg.naturalWidth) continue;
        maskSource = maskImg;
      }
      const tint = document.createElement('canvas');
      tint.width = cv.width;
      tint.height = cv.height;
      const tctx = tint.getContext('2d')!;
      tctx.drawImage(maskSource, 0, 0, cv.width, cv.height);
      tctx.globalCompositeOperation = 'source-in';
      const idx = surfaces.indexOf(s);
      tctx.fillStyle = surfaceColor(idx);
      tctx.fillRect(0, 0, tint.width, tint.height);
      ctx.save();
      ctx.globalAlpha = s.id === surfaceId ? 0.55 : 0.3;
      ctx.drawImage(tint, 0, 0);
      ctx.restore();
    }

    // Caja pendiente
    if (box) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2, cv.width / 500);
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);
    }

    // Puntos pendientes
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, cv.width / 120), 0, Math.PI * 2);
      ctx.fillStyle = p.positive ? '#22c55e' : '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [assetSurfaces, box, points, surfaceId, surfaces]);

  useEffect(() => {
    void redrawOverlay();
  }, [redrawOverlay, assetId]);

  // ------------------------------------------------------------------ tools

  function paintAt(p: { x: number; y: number }) {
    const c = brushCanvas();
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.arc(p.x, p.y, c.width / 40, 0, Math.PI * 2);
    ctx.fill();
    brushDirty.current = true;
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panning.current = true;
      panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      return;
    }
    const p = toImageCoords(e);
    if (!p || !canEdit) return;
    if (tool === 'box') {
      boxStart.current = p;
      setBox({ x: p.x, y: p.y, w: 0, h: 0 });
    } else if (tool === 'brush' || tool === 'eraser') {
      if (!surface) {
        setError('Selecciona primero una superficie para editar su máscara con el pincel.');
        return;
      }
      drawing.current = true;
      paintAt(p);
      void redrawOverlay();
    } else {
      setPoints((prev) => [...prev, { ...p, positive: tool === 'add' }]);
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (panning.current && panStart.current) {
      setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
      return;
    }
    const p = toImageCoords(e);
    if (!p) return;
    if (tool === 'box' && boxStart.current) {
      setBox({
        x: Math.min(boxStart.current.x, p.x),
        y: Math.min(boxStart.current.y, p.y),
        w: Math.abs(p.x - boxStart.current.x),
        h: Math.abs(p.y - boxStart.current.y),
      });
    } else if (drawing.current) {
      paintAt(p);
      void redrawOverlay();
    }
  }

  function onMouseUp() {
    panning.current = false;
    drawing.current = false;
    boxStart.current = null;
  }

  // ---------------------------------------------------------------- acciones

  function currentPromptSpec(): SurfacePromptSpec {
    return { points, box: box ?? undefined };
  }

  async function segmentNew() {
    if (!assetId) return;
    if (points.length === 0 && !box) {
      setError('Marca al menos un clic o una caja sobre la superficie.');
      return;
    }
    const label = newSurfaceLabel.trim() || `Superficie ${assetSurfaces.length + 1}`;
    setBusy('Segmentando…');
    setError(null);
    try {
      const res = await fetch('/app/visual-studio/api/surfaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, assetId, label, prompt: currentPromptSpec() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al segmentar');
      setPoints([]);
      setBox(null);
      setNewSurfaceLabel('');
      await refresh();
      setSurfaceId(data.surface.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al segmentar');
    } finally {
      setBusy(null);
    }
  }

  async function refine() {
    if (!surface) return;
    setBusy('Refinando…');
    setError(null);
    try {
      const body: Record<string, unknown> = { prompt: currentPromptSpec() };
      if (brushDirty.current && brushCanvasRef.current) {
        body.manualMaskPngBase64 = brushCanvasRef.current
          .toDataURL('image/png')
          .split(',')[1];
      }
      const res = await fetch(`/app/visual-studio/api/surfaces/${surface.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al refinar');
      setPoints([]);
      setBox(null);
      brushDirty.current = false;
      brushCanvasRef.current = null;
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al refinar');
    } finally {
      setBusy(null);
    }
  }

  async function removeSurface() {
    if (!surface) return;
    setBusy('Eliminando…');
    try {
      await fetch(`/app/visual-studio/api/surfaces/${surface.id}`, { method: 'DELETE' });
      setSurfaceId('');
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function uploadPhoto(file: File) {
    setBusy('Subiendo foto…');
    setError(null);
    try {
      await uploadFile(file, { target: { type: 'visual_project', id: projectId } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al subir');
    } finally {
      setBusy(null);
    }
  }

  async function uploadProductImage(file: File) {
    if (!productId) return;
    setBusy('Subiendo referencia…');
    try {
      await uploadFile(file, { target: { type: 'product_media', id: productId } });
      const res = await fetch(`/app/visual-studio/api/products/${productId}/media`);
      if (res.ok) setProductMedia((await res.json()).media);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al subir referencia');
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    if (!surfaceId || !prompt.trim()) return;
    setBusy('Solicitando…');
    setError(null);
    try {
      const res = await fetch('/app/visual-studio/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          surfaceId,
          productId: productId || null,
          mode,
          prompt: prompt.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al solicitar');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al solicitar');
    } finally {
      setBusy(null);
    }
  }

  async function selectProposal(id: string) {
    await fetch(`/app/visual-studio/api/proposals/${id}/select`, { method: 'POST' });
    await refresh();
  }

  // ------------------------------------------------------------------ render

  const toolButton = (t: Tool, label: string, title: string) => (
    <button
      key={t}
      className={`vs-tool ${tool === t ? 'active' : ''}`}
      onClick={() => setTool(t)}
      title={title}
      disabled={!canEdit}
    >
      {label}
    </button>
  );

  return (
    <div className="vs-editor">
      {/* Biblioteca */}
      <aside className="vs-col vs-library">
        <div className="vs-col-title">Fotografías</div>
        <label className={`vs-upload ${!canEdit ? 'disabled' : ''}`}>
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={!canEdit}
            onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])}
          />
          + Subir foto del cliente
        </label>
        {assets
          .filter((a) => a.kind === 'source')
          .map((a) => (
            <button
              key={a.id}
              className={`vs-asset ${a.id === assetId ? 'active' : ''}`}
              onClick={() => {
                setAssetId(a.id);
                setSurfaceId('');
                setPoints([]);
                setBox(null);
                brushDirty.current = false;
                brushCanvasRef.current = null;
              }}
            >
              <img src={a.contentUrl} alt={a.label ?? 'foto'} />
              <span>{a.label ?? 'Fotografía'}</span>
            </button>
          ))}
        <div className="vs-col-title" style={{ marginTop: 16 }}>
          Superficies
        </div>
        {assetSurfaces.map((s) => (
          <button
            key={s.id}
            className={`vs-surface-item ${s.id === surfaceId ? 'active' : ''}`}
            onClick={() => setSurfaceId(s.id === surfaceId ? '' : s.id)}
          >
            <span className="vs-dot" style={{ background: surfaceColor(surfaces.indexOf(s)) }} />
            {s.label}
          </button>
        ))}
        {surface && canEdit && (
          <button className="vs-btn danger small" onClick={removeSurface} disabled={!!busy}>
            Eliminar superficie
          </button>
        )}
      </aside>

      {/* Lienzo */}
      <section className="vs-canvas-wrap">
        <div className="vs-toolbar">
          {toolButton('add', '+ Clic', 'Clic positivo: incluir esta zona')}
          {toolButton('remove', '− Clic', 'Clic negativo: excluir esta zona')}
          {toolButton('box', '▭ Caja', 'Arrastra un rectángulo sobre la superficie')}
          {toolButton('brush', 'Pincel', 'Agrega zona a la máscara de la superficie activa')}
          {toolButton('eraser', 'Borrador', 'Quita zona de la máscara de la superficie activa')}
          <span className="vs-toolbar-spacer" />
          <button className="vs-tool" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
            −
          </button>
          <span className="vs-zoom">{Math.round(zoom * 100)}%</span>
          <button className="vs-tool" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
            +
          </button>
          <button className="vs-tool" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>
            Centrar
          </button>
        </div>

        <div className="vs-canvas" onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
          {asset ? (
            <div
              className="vs-canvas-inner"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
              <img
                ref={imgRef}
                src={asset.contentUrl}
                alt="Fotografía del espacio"
                draggable={false}
                onLoad={() => void redrawOverlay()}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
              />
              <canvas
                ref={overlayRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                }}
              />
            </div>
          ) : (
            <div className="vs-empty">Sube una fotografía para empezar.</div>
          )}
        </div>

        {canEdit && samConfigured && (
          <div className="vs-segment-bar">
            <input
              className="vs-input"
              placeholder="Nombre de la superficie (cubierta, salpicadero…)"
              value={newSurfaceLabel}
              onChange={(e) => setNewSurfaceLabel(e.target.value)}
            />
            <button
              className="vs-btn primary"
              onClick={segmentNew}
              disabled={!!busy || !assetId || (points.length === 0 && !box)}
            >
              Segmentar nueva
            </button>
            <button
              className="vs-btn"
              onClick={refine}
              disabled={!!busy || !surface || (points.length === 0 && !box && !brushDirty.current)}
            >
              Aplicar corrección
            </button>
          </div>
        )}

        {busy && <div className="vs-status">{busy}</div>}
        {error && <div className="vs-banner error">{error}</div>}

        {/* Comparador antes/después */}
        {compareProposal && asset && (
          <div className="vs-compare">
            <div className="vs-compare-frame">
              <img src={asset.contentUrl} alt="Antes" draggable={false} />
              <div className="vs-compare-after" style={{ width: `${slider}%` }}>
                <img src={compareProposal.resultUrl!} alt="Después" draggable={false} />
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={slider}
                onChange={(e) => setSlider(Number(e.target.value))}
                className="vs-compare-slider"
              />
            </div>
            <button className="vs-btn small" onClick={() => setCompareId(null)}>
              Cerrar comparador
            </button>
          </div>
        )}
      </section>

      {/* Catálogo + generación */}
      <aside className="vs-col vs-right">
        <div className="vs-col-title">Material UNIK</div>
        <input
          className="vs-input"
          placeholder="Buscar producto (nombre o SKU)…"
          value={productQuery}
          onChange={(e) => setProductQuery(e.target.value)}
        />
        <div className="vs-product-list">
          {products.map((p) => (
            <button
              key={p.id}
              className={`vs-product ${p.id === productId ? 'active' : ''}`}
              onClick={() => setProductId(p.id === productId ? '' : p.id)}
            >
              <span className="vs-product-name">{p.name ?? p.sku}</span>
              <span className="vs-product-meta">
                {p.sku}
                {p.mediaCount === 0 && ' · sin imágenes'}
              </span>
            </button>
          ))}
        </div>
        {productId && (
          <div className="vs-media-row">
            {productMedia.map((m) => (
              <img key={m.id} src={m.contentUrl} alt={m.label ?? 'referencia'} title={m.label ?? ''} />
            ))}
            {canEdit && (
              <label className="vs-upload small">
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => e.target.files?.[0] && uploadProductImage(e.target.files[0])}
                />
                +
              </label>
            )}
            {productMedia.length === 0 && (
              <span className="vs-hint">Sin referencias visuales — sube una foto del material.</span>
            )}
          </div>
        )}

        <div className="vs-col-title" style={{ marginTop: 12 }}>
          Propuesta
        </div>
        <div className="vs-mode-row">
          <button
            className={`vs-mode ${mode === 'faithful' ? 'active' : ''}`}
            onClick={() => setMode('faithful')}
          >
            Fiel
          </button>
          <button
            className={`vs-mode ${mode === 'creative' ? 'active' : ''}`}
            onClick={() => setMode('creative')}
          >
            Creativo
          </button>
        </div>
        <textarea
          className="vs-input vs-prompt"
          placeholder="Ej. Cambia la cubierta a granito Titanium manteniendo muebles e iluminación"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
        <button
          className="vs-btn primary"
          onClick={generate}
          disabled={!!busy || !canGenerate || !surfaceId || !prompt.trim()}
          title={!surfaceId ? 'Selecciona una superficie primero' : undefined}
        >
          Generar propuesta
        </button>
        {mode === 'creative' && (
          <div className="vs-hint">Visualización conceptual — no garantiza fidelidad dimensional.</div>
        )}

        <div className="vs-col-title" style={{ marginTop: 12 }}>
          Versiones
        </div>
        <div className="vs-proposal-list">
          {proposals.map((p) => (
            <div key={p.id} className={`vs-proposal ${p.status}`}>
              <div className="vs-proposal-head">
                <span>v{p.version} · {p.mode === 'faithful' ? 'Fiel' : 'Creativo'}</span>
                <span className={`vs-badge ${p.status}`}>
                  {p.status === 'pending' && 'En cola'}
                  {p.status === 'processing' && 'Generando…'}
                  {p.status === 'completed' && 'Lista'}
                  {p.status === 'failed' && 'Falló'}
                  {p.status === 'cancelled' && 'Cancelada'}
                </span>
              </div>
              {p.productName && <div className="vs-product-meta">{p.productName}</div>}
              {p.error && <div className="vs-error-text">{p.error}</div>}
              {p.resultUrl && (
                <button className="vs-result" onClick={() => setCompareId(p.id)}>
                  <img src={p.resultUrl} alt={`Propuesta v${p.version}`} />
                  <span>Comparar</span>
                </button>
              )}
              {p.status === 'completed' && canSelect && (
                <button
                  className="vs-btn small"
                  onClick={() => selectProposal(p.id)}
                  disabled={!!p.selectedAt}
                >
                  {p.selectedAt ? '✓ Elegida por el cliente' : 'El cliente eligió esta'}
                </button>
              )}
            </div>
          ))}
          {proposals.length === 0 && (
            <div className="vs-hint">Las propuestas generadas aparecerán aquí.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
