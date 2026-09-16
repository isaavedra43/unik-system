'use client';

import '@/styles/operations/inventario.css';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Camera, CheckCircle2, ListChecks, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { ScanInput } from '@/components/areas/ScanInput';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { Alert, Badge, Button, FormField, Input } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import { stockCountLink } from '@/modules/areas/area-links';
import { uploadFile } from '@/lib/upload-client';
import type { CountDetail } from '@/modules/inventory/inventory-queries';
import type { ScanLookup } from '@/modules/operations/scan-resolver';
import type { CaptureTarget } from './LocationDrawer';
import { countProgressLabel, formatQty, parseCountedQty } from './inventario-model';

/**
 * Captura de un conteo (plan 7.6 `CountCapture`): se escanea o se elige una
 * existencia, se captura la cantidad y la línea viaja por la cola offline
 * (`stock.count.line`), así que el almacén puede contar sin señal.
 *
 * The engine owns the arithmetic: the expected quantity is the book value at
 * capture time and the tolerance decides whether the line is accepted, left
 * pending or disputed. This screen only shows what came back.
 */

export interface CountCaptureProps {
  areaKey: string;
  countId: string;
  user: { id: string; name: string };
  /** The person holds `inventory.count`. */
  canCount: boolean;
  /** Work item the capture answers, when it was opened from a verification. */
  workItemId: string | null;
  /** Row picked in the map drawer (or by a scan). */
  target: CaptureTarget | null;
  onTargetChange: (target: CaptureTarget | null) => void;
  /** The count was closed or cancelled: the map goes back to its grid. */
  onFinished: () => void;
  /** Something changed in the warehouse (reload the map). */
  onChanged: () => void;
}

interface LineOutcome {
  expected: string;
  counted: string;
  diff: string;
  withinTolerance: boolean;
  baseUnit: string;
  recount: boolean;
}

function scanToTarget(lookup: ScanLookup): CaptureTarget | null {
  const item = lookup.items[0];
  if (!item) return null;
  return {
    stockItemId: item.id,
    title: item.title,
    subtitle: item.subtitle,
    unit: item.unit,
  };
}

export function CountCapture({
  areaKey,
  countId,
  user,
  canCount,
  workItemId,
  target,
  onTargetChange,
  onFinished,
  onChanged,
}: CountCaptureProps) {
  const { submit, online } = useOfflineCommandQueue(user.id);
  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LineOutcome | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/inventario/counts/${encodeURIComponent(countId)}`
      );
      const json = (await response.json().catch(() => ({}))) as Partial<CountDetail> & {
        error?: string;
      };
      if (!response.ok || !json.count) throw new Error(json.error ?? 'No pudimos cargar el conteo');
      setDetail(json as CountDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar el conteo');
    } finally {
      setLoading(false);
    }
  }, [areaKey, countId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    setQuantity('');
    setFormError(null);
    setOutcome(null);
    setUnit(target?.unit ?? '');
  }, [target]);

  const run = useCallback(
    async (
      input: Parameters<typeof submit>[0],
      successMessage: string
    ): Promise<{ ok: boolean; data: unknown }> => {
      const result = await submit(input);
      const feedback = describeSubmitOutcome(result, successMessage);
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      const ok = feedback.kind === 'success' || feedback.kind === 'queued';
      const data = !result.queued ? result.result.data : null;
      return { ok, data };
    },
    [submit]
  );

  async function submitLine() {
    if (!target?.stockItemId || busy) return;
    const parsed = parseCountedQty(quantity);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      const { ok, data } = await run(
        {
          type: 'stock.count.line',
          aggregate: { type: 'stock_count', id: countId },
          payload: {
            countId,
            stockItemId: target.stockItemId,
            countedQty: parsed.value,
            ...(unit.trim() ? { unit: unit.trim() } : {}),
          },
        },
        'Línea capturada'
      );
      if (ok) {
        const line = data as Partial<LineOutcome> | null;
        if (line && typeof line.diff === 'string') {
          setOutcome({
            expected: String(line.expected ?? ''),
            counted: String(line.counted ?? parsed.value),
            diff: line.diff,
            withinTolerance: line.withinTolerance === true,
            baseUnit: String(line.baseUnit ?? unit ?? ''),
            recount: line.recount === true,
          });
        }
        setQuantity('');
        setReload((value) => value + 1);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function closeCount() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const { ok } = await run(
        {
          type: 'stock.count.close',
          aggregate: { type: 'stock_count', id: countId },
          payload: { countId },
          expectedVersion: detail.count.version,
        },
        'Conteo cerrado'
      );
      if (ok) {
        onChanged();
        onFinished();
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelCount() {
    if (!detail || busy) return;
    if (!window.confirm('¿Cancelar el conteo? Las líneas capturadas se descartan.')) return;
    setBusy(true);
    try {
      const { ok } = await run(
        {
          type: 'stock.count.cancel',
          aggregate: { type: 'stock_count', id: countId },
          payload: { countId },
          expectedVersion: detail.count.version,
        },
        'Conteo cancelado'
      );
      if (ok) {
        onChanged();
        onFinished();
      }
    } finally {
      setBusy(false);
    }
  }

  async function attachPhoto(file: File | null) {
    if (!file || !workItemId || uploading) return;
    if (!online) {
      toast.error('Sin conexión: la foto se puede subir cuando vuelva la señal.');
      return;
    }
    setUploading(true);
    try {
      await uploadFile(file, {
        target: { type: 'operations_evidence', id: `work_item:${workItemId}#photo` },
      });
      toast.success('Foto adjuntada a la verificación');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir la foto');
    } finally {
      setUploading(false);
    }
  }

  if (loading) return <LoadingState variant="list" rows={4} label="Cargando el conteo…" />;
  if (error) {
    return (
      <ErrorState
        title="No pudimos cargar el conteo"
        message={error}
        onRetry={() => setReload((value) => value + 1)}
      />
    );
  }
  if (!detail) {
    return (
      <div className="area-empty">
        <strong>Conteo no disponible</strong>
        <p>Es posible que ya se haya cerrado o cancelado.</p>
      </div>
    );
  }

  const open = detail.count.status === 'draft' || detail.count.status === 'in_progress';
  const disputed = detail.lines.filter((line) => line.resolution === 'disputed').length;
  // Lo que quedó esperando una decisión al cerrar: se decide en el conteo.
  const pendingDecisions =
    disputed + detail.lines.filter((line) => line.resolution === 'pending').length;

  return (
    <div className="inv-capture">
      <div className="inv-capture-head">
        <div className="inv-list-main">
          <strong>
            {detail.count.scopeLabel} · {detail.warehouseName ?? 'Bodega'}
          </strong>
          <span className="inv-list-sub">
            {countProgressLabel({ lines: detail.lines.length, disputed })}
          </span>
        </div>
        <Badge variant={open ? 'info' : 'success'}>{detail.count.statusLabel}</Badge>
      </div>

      {!online ? (
        <Alert variant="info">
          Sin conexión: las líneas se guardan en este dispositivo y se envían solas al volver la
          señal.
        </Alert>
      ) : null}

      {!open ? (
        <Alert variant="info">
          Este conteo ya está {detail.count.statusLabel.toLowerCase()}.{' '}
          {pendingDecisions > 0 ? (
            <>
              Quedan {pendingDecisions}{' '}
              {pendingDecisions === 1 ? 'diferencia por decidir' : 'diferencias por decidir'}:{' '}
              <Link className="inv-capture-link" href={stockCountLink(countId)}>
                ábrelo para autorizar el ajuste o resolver la disputa
              </Link>
              .
            </>
          ) : (
            'No quedan diferencias por decidir.'
          )}
        </Alert>
      ) : null}

      {canCount && open ? (
        <>
          <ScanInput
            warehouseId={detail.count.warehouseId}
            footer={(lookup) => {
              const scanned = scanToTarget(lookup);
              if (!scanned) return null;
              return (
                <Button size="sm" onClick={() => onTargetChange(scanned)}>
                  Contar {scanned.title}
                </Button>
              );
            }}
          />

          {target?.stockItemId ? (
            <div className="inv-card">
              <p className="inv-card-title">
                <span>{target.title}</span>
                <Button variant="ghost" size="sm" onClick={() => onTargetChange(null)}>
                  Cambiar
                </Button>
              </p>
              {target.subtitle ? <p className="inv-card-hint">{target.subtitle}</p> : null}

              <div className="inv-capture-form">
                <FormField
                  label="Cantidad contada"
                  htmlFor="inv-count-qty"
                  error={formError}
                  help="Lo que ves físicamente, no lo que dice el sistema."
                >
                  <Input
                    id="inv-count-qty"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    enterKeyHint="done"
                    error={formError}
                    autoFocus
                  />
                </FormField>
                <FormField
                  label="Unidad"
                  htmlFor="inv-count-unit"
                  help="Vacío usa la unidad base del artículo."
                >
                  <Input
                    id="inv-count-unit"
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                    autoComplete="off"
                    maxLength={30}
                  />
                </FormField>
              </div>

              <div className="inv-capture-actions">
                <Button size="sm" onClick={submitLine} isLoading={busy}>
                  <ListChecks size={14} aria-hidden="true" />
                  Guardar línea
                </Button>
                {workItemId ? (
                  <label className="btn btn-secondary btn-sm">
                    <Camera size={14} aria-hidden="true" />
                    {uploading ? 'Subiendo…' : 'Adjuntar foto'}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      onChange={(event) => void attachPhoto(event.target.files?.[0] ?? null)}
                    />
                  </label>
                ) : null}
              </div>

              {outcome ? (
                <Alert variant={outcome.withinTolerance ? 'success' : 'warning'}>
                  Esperado {formatQty(outcome.expected, outcome.baseUnit)} · contado{' '}
                  {formatQty(outcome.counted, outcome.baseUnit)} · diferencia{' '}
                  <span className={outcome.withinTolerance ? 'inv-diff-ok' : 'inv-diff-off'}>
                    {formatQty(outcome.diff, outcome.baseUnit)}
                  </span>
                  {outcome.withinTolerance
                    ? '. Dentro de tolerancia.'
                    : '. Fuera de tolerancia: al cerrar se abrirá una disputa.'}
                  {outcome.recount ? ' Actualizamos la línea anterior.' : ''}
                </Alert>
              ) : null}
            </div>
          ) : (
            <p className="inv-card-hint">
              Escanea una etiqueta o elige una existencia desde el mapa para capturar su cantidad.
            </p>
          )}
        </>
      ) : null}

      <section className="inv-card" aria-labelledby="inv-count-lines">
        <h3 id="inv-count-lines" className="inv-card-title">
          Líneas capturadas
        </h3>
        {detail.lines.length === 0 ? (
          <p className="inv-card-hint">Todavía no hay líneas en este conteo.</p>
        ) : (
          <ul className="inv-list">
            {detail.lines.map((line) => (
              <li key={line.id} className="inv-list-item">
                <span className="inv-list-main">
                  <span>{line.productName ?? line.sku ?? line.zohoItemId ?? 'Artículo'}</span>
                  <span className="inv-list-sub">
                    {[line.locationCode, line.variantLabel, line.containerKey, line.resolutionLabel]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="inv-qty">
                  {formatQty(line.countedQty, line.unit)}{' '}
                  <span className={line.withinTolerance ? 'inv-diff-ok' : 'inv-diff-off'}>
                    ({formatQty(line.diffQty)})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canCount && open ? (
        <div className="inv-capture-actions inv-sticky-bar">
          <Button
            size="sm"
            onClick={closeCount}
            isLoading={busy}
            disabled={detail.lines.length === 0}
          >
            <CheckCircle2 size={14} aria-hidden="true" />
            Cerrar conteo
          </Button>
          <Button variant="danger" size="sm" onClick={cancelCount} disabled={busy}>
            <XCircle size={14} aria-hidden="true" />
            Cancelar
          </Button>
        </div>
      ) : null}
    </div>
  );
}
