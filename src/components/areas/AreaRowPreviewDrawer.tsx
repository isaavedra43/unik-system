'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing, Paperclip, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Drawer } from '@/components/ui/composite';
import { Alert, Badge, Button, Select } from '@/components/ui/primitives';
import {
  EVIDENCE_UPLOAD_TARGET,
  FILE_EVIDENCE_KINDS,
  acceptForEvidenceKind,
  evidenceLabel,
  validateEvidenceFiles,
  type FileEvidenceKind,
} from '@/components/operations/mywork-model';
import { uploadFile } from '@/lib/upload-client';
import type { AreaRowDetail, AreaWorkRow } from '@/modules/areas/area-work-row';
import { rowKindLabel } from '@/modules/areas/area-work-row';
import {
  getRowActions,
  noActionsReason,
  type AreaRowAction,
  type RowActionActor,
} from '@/modules/areas/work-actions';
import type { WatchAction } from '@/modules/shared/entity-workspace-types';

export interface AreaRowPreviewDrawerProps {
  areaKey: string;
  areaLabel: string;
  rowId: string;
  entityLabel: string;
  actor: RowActionActor;
  actPermissions: string[];
  canWatch: boolean;
  isWatched: boolean;
  online: boolean;
  onClose: () => void;
  onWatchChange: (watched: boolean) => void;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
  /** Raises an action so the workspace opens its dialog (and sends the command). */
  onAction: (row: AreaWorkRow, action: AreaRowAction) => void;
  /** Version counter: changing it reloads the detail after a command. */
  refreshToken: number;
}

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

/**
 * Detail of a work row (plan 7.4): its facts, the case summary and timeline
 * (only when the case rule lets this person in), its evidence with upload, and
 * the actions the engine would accept.
 */
export function AreaRowPreviewDrawer({
  areaKey,
  areaLabel,
  rowId,
  entityLabel,
  actor,
  actPermissions,
  canWatch,
  isWatched,
  online,
  onClose,
  onWatchChange,
  watchAction,
  unwatchAction,
  onAction,
  refreshToken,
}: AreaRowPreviewDrawerProps) {
  const [detail, setDetail] = useState<AreaRowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);
  const [kind, setKind] = useState<FileEvidenceKind>('photo');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => setWatched(isWatched), [isWatched]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/rows/${encodeURIComponent(rowId)}`
      );
      const json = (await response.json().catch(() => ({}))) as {
        detail?: AreaRowDetail;
        error?: string;
      };
      if (!response.ok || !json.detail) {
        throw new Error(json.error ?? 'No pudimos cargar el detalle');
      }
      setDetail(json.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar el detalle');
    } finally {
      setLoading(false);
    }
  }, [areaKey, rowId]);

  useEffect(() => {
    void load();
  }, [load, reload, refreshToken]);

  async function toggleWatch() {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', rowId);
    const run = watched ? unwatchAction : watchAction;
    const result = await run({ error: null, success: false, isWatched: watched }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
    } else {
      toast.error(result.error ?? 'No se pudo cambiar el seguimiento');
    }
  }

  async function uploadEvidence() {
    if (!detail?.evidenceTargetId || files.length === 0 || uploading) return;
    const invalid = validateEvidenceFiles(files);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    if (!online) {
      toast.error('Sin conexión: la evidencia sólo se puede subir en línea.');
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        await uploadFile(file, {
          target: { type: EVIDENCE_UPLOAD_TARGET, id: `${detail.evidenceTargetId}#${kind}` },
        });
      }
      toast.success(files.length === 1 ? 'Evidencia adjuntada' : 'Evidencias adjuntadas');
      setFiles([]);
      setReload((value) => value + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir la evidencia');
    } finally {
      setUploading(false);
    }
  }

  const row = detail?.row ?? null;
  const actions = row ? getRowActions(row, actor, { actPermissions }) : [];
  const subtitle = row
    ? `${rowKindLabel(row.rowKind)} · ${row.statusLabel}${row.caseNumber ? ` · ${row.caseNumber}` : ''}`
    : areaLabel;

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={row?.title ?? entityLabel}
      subtitle={subtitle}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cerrar
          </Button>
          {row && actions.length > 0 ? (
            <Button
              variant={actions[0].tone === 'danger' ? 'danger' : 'primary'}
              size="sm"
              onClick={() => onAction(row, actions[0])}
            >
              {actions[0].label}
            </Button>
          ) : null}
        </>
      }
    >
      {loading ? (
        <LoadingState variant="list" rows={5} label="Cargando el detalle…" />
      ) : error ? (
        <ErrorState
          title="No pudimos cargar el detalle"
          message={error}
          onRetry={() => setReload((v) => v + 1)}
        />
      ) : !detail || !row ? (
        <div className="area-empty">
          <strong>Sin detalle</strong>
          <p>Esta fila ya no está disponible en {areaLabel}.</p>
        </div>
      ) : (
        <div className="area-drawer-body">
          <div className="area-drawer-section">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={BADGE_BY_TONE[row.statusTone]}>{row.statusLabel}</Badge>
              {row.overdue ? <Badge variant="danger">Vencido</Badge> : null}
              {row.priority !== 'normal' ? (
                <Badge variant="warning">{row.priorityLabel}</Badge>
              ) : null}
              {canWatch ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={toggleWatch}
                  aria-label={watched ? 'Dejar de seguir esta fila' : 'Seguir esta fila'}
                >
                  {watched ? <BellRing size={14} /> : <Bell size={14} />}
                  {watched ? 'Siguiendo' : 'Seguir'}
                </button>
              ) : null}
            </div>
          </div>

          <section className="area-drawer-section" aria-labelledby="area-drawer-facts">
            <h4 id="area-drawer-facts" className="area-drawer-section-title">
              Datos
            </h4>
            <dl className="area-drawer-fields">
              {detail.fields.map((fact) => (
                <div key={`${fact.label}-${fact.value}`} className="area-drawer-field">
                  <dt>{fact.label}</dt>
                  <dd>
                    {fact.value}
                    {fact.hint ? <div className="area-row-sub">{fact.hint}</div> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {detail.freeText ? (
            <section className="area-drawer-section" aria-labelledby="area-drawer-free">
              <h4 id="area-drawer-free" className="area-drawer-section-title">
                Texto de quien la escribió
              </h4>
              <blockquote className="area-drawer-quote">{detail.freeText}</blockquote>
            </section>
          ) : null}

          {detail.caseSummary ? (
            <section className="area-drawer-section" aria-labelledby="area-drawer-case">
              <h4 id="area-drawer-case" className="area-drawer-section-title">
                Expediente {detail.caseSummary.caseNumber}
              </h4>
              <p className="text-sm">
                {detail.caseSummary.customerName ?? 'Sin cliente'} · {detail.caseSummary.phaseLabel}{' '}
                · {detail.caseSummary.statusLabel}
              </p>
              <p className="area-row-sub">
                {detail.caseSummary.openWorkItems} trabajos abiertos ·{' '}
                {detail.caseSummary.openRequests} solicitudes · {detail.caseSummary.openIncidents}{' '}
                incidencias
              </p>
              {detail.caseSummary.demands.length > 0 ? (
                <ul className="area-comms-list">
                  {detail.caseSummary.demands.map((demand) => (
                    <li key={`${demand.name}-${demand.quantity}`} className="area-row-sub">
                      {demand.name} · {demand.quantity} {demand.unit} · {demand.statusLabel}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : detail.caseRestricted ? (
            <Alert variant="info">
              Este trabajo pertenece a un expediente al que no tienes acceso, así que no mostramos
              su resumen ni su cronología.
            </Alert>
          ) : null}

          {detail.timeline.length > 0 ? (
            <section className="area-drawer-section" aria-labelledby="area-drawer-timeline">
              <h4 id="area-drawer-timeline" className="area-drawer-section-title">
                Cronología
              </h4>
              <ul className="area-timeline">
                {detail.timeline.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="area-drawer-section" aria-labelledby="area-drawer-evidence">
            <h4 id="area-drawer-evidence" className="area-drawer-section-title">
              Evidencias
            </h4>
            {detail.missingEvidence.length > 0 ? (
              <Alert variant="warning">
                Falta {detail.missingEvidence.map((key) => evidenceLabel(key)).join(', ')}.
              </Alert>
            ) : null}
            {detail.evidence.length > 0 ? (
              <ul className="area-evidence-list">
                {detail.evidence.map((item) => (
                  <li key={item.id} className="area-evidence-item">
                    <Paperclip size={14} aria-hidden="true" />
                    <span>
                      {item.label}
                      {item.note ? ` · ${item.note}` : ''}
                      {item.createdByName ? ` · ${item.createdByName}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="area-row-sub">Todavía no hay evidencias adjuntas.</p>
            )}

            {detail.evidenceTargetId ? (
              <div className="grid gap-2">
                <label className="form-label" htmlFor="area-evidence-kind">
                  Tipo de evidencia
                </label>
                <Select
                  id="area-evidence-kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as FileEvidenceKind)}
                >
                  {FILE_EVIDENCE_KINDS.map((option) => (
                    <option key={option} value={option}>
                      {evidenceLabel(option)}
                    </option>
                  ))}
                </Select>
                <label className="form-label" htmlFor="area-evidence-file">
                  Archivo
                </label>
                <input
                  id="area-evidence-file"
                  type="file"
                  multiple
                  accept={acceptForEvidenceKind(kind)}
                  onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                />
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={uploadEvidence}
                    disabled={uploading || files.length === 0 || !online}
                  >
                    <Upload size={14} aria-hidden="true" />
                    {uploading ? 'Subiendo…' : 'Subir evidencia'}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="area-drawer-section" aria-labelledby="area-drawer-actions">
            <h4 id="area-drawer-actions" className="area-drawer-section-title">
              Acciones
            </h4>
            {actions.length === 0 ? (
              <p className="area-row-sub">{noActionsReason(row, actor)}</p>
            ) : (
              <div className="area-drawer-actions">
                {actions.map((action) => (
                  <Button
                    key={action.id}
                    variant={
                      action.tone === 'danger'
                        ? 'danger'
                        : action.tone === 'primary'
                          ? 'primary'
                          : 'secondary'
                    }
                    size="sm"
                    onClick={() => onAction(row, action)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
