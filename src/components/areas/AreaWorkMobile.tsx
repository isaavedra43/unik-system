'use client';

import '@/styles/operations/area-mobile.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Camera, QrCode, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { operationsCaseHref } from '@/components/operations/copilot-starters';
import {
  EVIDENCE_UPLOAD_TARGET,
  acceptForEvidenceKind,
  validateEvidenceFiles,
} from '@/components/operations/mywork-model';
import { Alert, Button, FormField, Select, Textarea } from '@/components/ui/primitives';
import { uploadFile } from '@/lib/upload-client';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { AreaClientMeta } from '@/modules/areas/area-registry';
import type { AreaRowDetail, AreaWorkRow } from '@/modules/areas/area-work-row';
import { pickNextAction } from '@/modules/areas/next-action';
import {
  getRowActions,
  type AreaRowAction,
  type RowActionActor,
} from '@/modules/areas/work-actions';
import { NextActionCard } from './NextActionCard';
import { ScanInput } from './ScanInput';
import { WorkCardList } from './WorkCardList';
import {
  CAPTURE_KIND_LABELS,
  CAPTURE_NOTE_MAX,
  buildEvidenceNoteCommand,
  evidenceUploadTargetId,
  isScanRequested,
  mobileCountLabel,
  type MobileView,
} from './area-mobile-model';

/**
 * Area work centre on a phone (plan 7.10, ≤768 px). One column at a time
 * (`MobileView`, like the inbox): the list with "Mi siguiente acción" and the
 * work cards, the full detail of a row, or the area copilot.
 *
 * The fixed bottom bar is the operational shortcut: **Capturar** (a note that
 * survives offline, or a photo / document), **Escanear** (label, location or
 * SKU) and **IA**.
 *
 * It owns no business rule: rows come from the area API, every action is a
 * command of the engine sent through the offline queue by the workspace, the
 * detail is the shared drawer and the copilot is the shared panel.
 */

export interface AreaWorkMobileProps {
  user: { id: string; name: string };
  area: AreaClientMeta;
  rows: readonly AreaWorkRow[];
  /** Rows matching the query (the page shows the first ones). */
  total: number;
  /** Server time of the render, so due labels match on hydration. */
  now: Date;
  actor: RowActionActor;
  actPermissions: string[];
  canUseAssistant: boolean;
  online: boolean;
  /** Realtime events waiting to be shown. */
  pendingEvents: number;
  onRefresh: () => void;
  /** Raises a row action so the workspace opens its dialog and sends the command. */
  onAction: (row: AreaWorkRow, action: AreaRowAction) => void;
  /** Sends a command (or queues it offline); true when it was accepted or queued. */
  onRunCommand: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
  /** Visible table sent to the copilot on every turn. */
  copilotContext: () => Record<string, unknown>;
  activityAt: string | null;
  /** Filter chips of the space (row kind / scope). */
  chips?: ReactNode;
  /** Full detail of a row (the shared drawer), rendered by the workspace. */
  renderDetail: (rowId: string, onClose: () => void) => ReactNode;
  /** Search params of the page: `?scan=1` (PWA shortcut) opens the scanner. */
  searchParams?: Record<string, string | undefined>;
}

type CaptureFileKind = 'photo' | 'document';
const CAPTURE_FILE_KINDS: CaptureFileKind[] = ['photo', 'document'];

export function AreaWorkMobile({
  user,
  area,
  rows,
  total,
  now,
  actor,
  actPermissions,
  canUseAssistant,
  online,
  pendingEvents,
  onRefresh,
  onAction,
  onRunCommand,
  copilotContext,
  activityAt,
  chips,
  renderDetail,
  searchParams,
}: AreaWorkMobileProps) {
  const [view, setView] = useState<MobileView>('list');
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'capture' | 'scan' | null>(null);

  const [captureTarget, setCaptureTarget] = useState<string | null>(null);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileKind, setFileKind] = useState<CaptureFileKind>('photo');
  const [saving, setSaving] = useState(false);

  // Dentro de cada nivel, una fila en la que SÍ se puede actuar gana a una que
  // sólo se puede mirar: la tarjeta dice qué hacer ahora, no qué contemplar.
  const next = useMemo(
    () =>
      pickNextAction(rows, user.id, now, {
        hasActions: (row) => getRowActions(row, actor, { actPermissions }).length > 0,
      }),
    [rows, user.id, now, actor, actPermissions]
  );
  const captureRowId = openRowId ?? next?.row.id ?? rows[0]?.id ?? null;
  const captureRow = useMemo(
    () => rows.find((row) => row.id === captureRowId) ?? null,
    [rows, captureRowId]
  );

  // The PWA shortcut ("Escanear") opens the scanner once, not on every render.
  // Without explicit params it reads the address bar, so the host page does not
  // need a Suspense boundary for `useSearchParams`.
  const scanParam = searchParams ? (isScanRequested(searchParams) ? '1' : '0') : null;
  const scanOpened = useRef(false);
  useEffect(() => {
    if (scanOpened.current) return;
    const requested =
      scanParam !== null
        ? scanParam === '1'
        : typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('scan') === '1';
    if (requested) {
      scanOpened.current = true;
      setSheet('scan');
    }
  }, [scanParam]);

  const openRow = useCallback((row: AreaWorkRow) => {
    setOpenRowId(row.id);
    setView('detail');
  }, []);

  const closeDetail = useCallback(() => {
    setOpenRowId(null);
    setView('list');
  }, []);

  // Where the evidence of the row goes (`work_item:<id>`, …): the detail knows.
  useEffect(() => {
    if (sheet !== 'capture' || !captureRowId) return;
    let cancelled = false;
    setCaptureLoading(true);
    setCaptureError(null);
    setCaptureTarget(null);
    void fetch(
      `/app/areas/${encodeURIComponent(area.key)}/api/rows/${encodeURIComponent(captureRowId)}`
    )
      .then(async (response) => {
        const json = (await response.json().catch(() => ({}))) as {
          detail?: AreaRowDetail;
          error?: string;
        };
        if (!response.ok || !json.detail) {
          throw new Error(json.error ?? 'No pudimos preparar la captura');
        }
        if (!cancelled) setCaptureTarget(json.detail.evidenceTargetId);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCaptureError(err instanceof Error ? err.message : 'No pudimos preparar la captura');
        }
      })
      .finally(() => {
        if (!cancelled) setCaptureLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sheet, captureRowId, area.key]);

  function closeSheet() {
    setSheet(null);
    setNote('');
    setFiles([]);
    setCaptureError(null);
  }

  async function saveNote() {
    if (saving) return;
    const built = buildEvidenceNoteCommand(captureTarget, note);
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    setSaving(true);
    try {
      const done = await onRunCommand(built.command, 'Nota guardada');
      if (done) closeSheet();
    } finally {
      setSaving(false);
    }
  }

  async function uploadEvidence() {
    if (saving || !captureTarget || files.length === 0) return;
    const invalid = validateEvidenceFiles(files);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    if (!online) {
      toast.error('Sin conexión: la foto se sube al reconectar. La nota sí se guarda ahora.');
      return;
    }
    setSaving(true);
    try {
      for (const file of files) {
        await uploadFile(file, {
          target: {
            type: EVIDENCE_UPLOAD_TARGET,
            id: evidenceUploadTargetId(captureTarget, fileKind),
          },
        });
      }
      toast.success(files.length === 1 ? 'Evidencia adjuntada' : 'Evidencias adjuntadas');
      closeSheet();
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir la evidencia');
    } finally {
      setSaving(false);
    }
  }

  const caseHref = next ? operationsCaseHref(next.row.caseId) : null;

  return (
    <div className="area-mobile">
      <div className="area-mobile-head">
        <span className="area-mobile-meta">{mobileCountLabel(rows.length, total)}</span>
        {pendingEvents > 0 ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRefresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {pendingEvents === 1 ? '1 movimiento nuevo' : `${pendingEvents} movimientos nuevos`}
          </Button>
        ) : null}
      </div>

      {chips}

      <NextActionCard
        next={next}
        areaLabel={area.label}
        now={now}
        actor={actor}
        actPermissions={actPermissions}
        caseHref={caseHref}
        onAction={onAction}
        onOpen={openRow}
      />

      <WorkCardList
        rows={rows}
        now={now}
        actor={actor}
        actPermissions={actPermissions}
        activeRowId={openRowId}
        onOpen={openRow}
        onAction={onAction}
        emptyTitle={`Nada que atender en ${area.label}`}
        emptyMessage="Cambia los filtros o espera a que llegue trabajo nuevo."
      />

      <nav className="area-mobile-bar" aria-label={`Acciones rápidas de ${area.label}`}>
        <button
          type="button"
          className="area-mobile-bar-btn"
          onClick={() => setSheet('capture')}
          disabled={!captureRow}
          title={captureRow ? undefined : 'Abre un pendiente para capturar su evidencia'}
        >
          <Camera size={18} aria-hidden="true" />
          <span className="area-mobile-bar-label">Capturar</span>
        </button>
        <button type="button" className="area-mobile-bar-btn" onClick={() => setSheet('scan')}>
          <QrCode size={18} aria-hidden="true" />
          <span className="area-mobile-bar-label">Escanear</span>
        </button>
        {canUseAssistant ? (
          <button
            type="button"
            className={`area-mobile-bar-btn ${view === 'ai' ? 'area-mobile-bar-active' : ''}`.trim()}
            onClick={() => setView('ai')}
            aria-haspopup="dialog"
          >
            <Sparkles size={18} aria-hidden="true" />
            <span className="area-mobile-bar-label">IA</span>
          </button>
        ) : null}
      </nav>

      {view === 'detail' && openRowId ? renderDetail(openRowId, closeDetail) : null}

      <Sheet open={sheet === 'capture'} onOpenChange={(open) => (open ? null : closeSheet())}>
        <SheetContent side="bottom" className="p-0">
          <SheetTitle className="sr-only">Capturar evidencia</SheetTitle>
          <SheetDescription className="sr-only">
            Guarda una nota o adjunta una foto al pendiente seleccionado.
          </SheetDescription>
          <div className="area-sheet">
            <p className="area-sheet-title">Capturar evidencia</p>
            <p className="area-sheet-hint">
              {captureRow ? captureRow.title : 'Elige primero un pendiente.'}
            </p>

            {captureLoading ? (
              <p className="area-sheet-hint">Preparando la captura…</p>
            ) : captureError ? (
              <Alert variant="error">{captureError}</Alert>
            ) : !captureTarget ? (
              <Alert variant="info">
                Este pendiente todavía no admite evidencia. Ábrelo para ver lo que necesita.
              </Alert>
            ) : (
              <>
                <FormField
                  label="Nota"
                  htmlFor="area-capture-note"
                  help="Se guarda aunque estés sin conexión: se envía sola al reconectar."
                >
                  <Textarea
                    id="area-capture-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={3}
                    maxLength={CAPTURE_NOTE_MAX}
                  />
                </FormField>
                <div className="area-sheet-actions">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void saveNote()}
                    isLoading={saving}
                    disabled={!note.trim()}
                  >
                    Guardar nota
                  </Button>
                </div>

                <FormField label="Tipo de archivo" htmlFor="area-capture-kind">
                  <Select
                    id="area-capture-kind"
                    value={fileKind}
                    onChange={(event) => setFileKind(event.target.value as CaptureFileKind)}
                  >
                    {CAPTURE_FILE_KINDS.map((option) => (
                      <option key={option} value={option}>
                        {CAPTURE_KIND_LABELS[option]}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={fileKind === 'photo' ? 'Foto' : 'Documento'}
                  htmlFor="area-capture-file"
                  help={online ? undefined : 'Los archivos sólo se suben en línea.'}
                >
                  <input
                    id="area-capture-file"
                    type="file"
                    multiple
                    accept={acceptForEvidenceKind(fileKind)}
                    {...(fileKind === 'photo' ? { capture: 'environment' as const } : {})}
                    onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                  />
                </FormField>
                <div className="area-sheet-actions">
                  <Button type="button" size="sm" variant="secondary" onClick={closeSheet}>
                    Cerrar
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void uploadEvidence()}
                    isLoading={saving}
                    disabled={files.length === 0 || !online}
                  >
                    Subir {CAPTURE_KIND_LABELS[fileKind].toLowerCase()}
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={sheet === 'scan'} onOpenChange={(open) => (open ? null : closeSheet())}>
        <SheetContent side="bottom" className="p-0">
          <SheetTitle className="sr-only">Escanear un código</SheetTitle>
          <SheetDescription className="sr-only">
            Lee una etiqueta, una ubicación o un SKU con la cámara o escríbelo.
          </SheetDescription>
          <div className="area-sheet">
            <p className="area-sheet-title">Escanear</p>
            <ScanInput autoFocus />
            <div className="area-sheet-actions">
              <Button type="button" size="sm" variant="secondary" onClick={closeSheet}>
                Cerrar
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {canUseAssistant ? (
        <Sheet open={view === 'ai'} onOpenChange={(open) => setView(open ? 'ai' : 'list')}>
          <SheetContent
            side="right"
            className="w-full gap-0 p-0 sm:max-w-md"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">{`IA de ${area.label}`}</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del área sobre el trabajo visible en este teléfono.
            </SheetDescription>
            {view === 'ai' ? (
              <div className="area-sheet-ai">
                <AreaCopilotPanel
                  areaKey={area.key}
                  user={user}
                  activityAt={activityAt}
                  context={copilotContext}
                  starters={area.copilotStarters}
                  onAfterTurn={onRefresh}
                  onBack={() => setView('list')}
                />
              </div>
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
