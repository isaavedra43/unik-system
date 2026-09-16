'use client';

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  inspectOrderAction,
  releaseOrderAction,
  requestScrapReviewAction,
} from '@/app/app/manufacturing/actions';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import {
  EVIDENCE_UPLOAD_TARGET,
  validateEvidenceFiles,
} from '@/components/operations/mywork-model';
import { uploadFile } from '@/lib/upload-client';
import type {
  ProductionOperationDTO,
  QualityCheckDTO,
} from '@/modules/manufacturing/manufacturing-dto';
import type { ProductionOrderRow } from '@/modules/manufacturing/manufacturing-queries';
import { MANUFACTURING_OBJECT_TYPES } from '@/modules/manufacturing/manufacturing-types';
import type { ReleaseEvaluation } from '@/modules/manufacturing/production-state';
import type { ScrapApprovalState, ScrapEvaluation } from '@/modules/manufacturing/scrap-rules';
import { useOrderAction } from './use-order-action';

export interface OrderQualityPanelProps {
  order: ProductionOrderRow;
  operations: ProductionOperationDTO[];
  qualityChecks: QualityCheckDTO[];
  scrap: ScrapEvaluation;
  scrapApproval: ScrapApprovalState;
  release: ReleaseEvaluation;
  pendingSubstitutions: number;
}

/**
 * Quality, scrap and release of a production order.
 *
 * A failed inspection orders a rework (the command creates the operation), scrap
 * beyond tolerance needs its approval before the order can be released, and the
 * release itself lists exactly what the engine says is still blocking it — the
 * button never lies about being available.
 */

const inspectSchema = z
  .object({
    result: z.enum(['pass', 'fail', 'conditional']),
    operationId: z.string().trim().max(120),
    notes: z.string().trim().max(2000),
    reworkOperationName: z.string().trim().max(120),
    checklist: z.array(
      z.object({
        item: z.string().trim().min(1, 'Describe el punto revisado').max(200),
        ok: z.boolean(),
        note: z.string().trim().max(500),
      })
    ),
  })
  .superRefine((value, ctx) => {
    if (value.result !== 'pass' && !value.notes.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message:
          value.result === 'fail' ? 'Describe la falla de calidad' : 'Describe las observaciones',
      });
    }
  });
type InspectValues = z.output<typeof inspectSchema>;

const SCRAP_APPROVAL_LABELS: Record<ScrapApprovalState, string> = {
  none: 'Sin revisión solicitada',
  pending: 'Esperando aprobación',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  stale: 'Hay merma nueva: pide otra revisión',
};

export function OrderQualityPanel({
  order,
  operations,
  qualityChecks,
  scrap,
  scrapApproval,
  release,
  pendingSubstitutions,
}: OrderQualityPanelProps) {
  const { runAction, pending, error } = useOrderAction();
  const [inspectOpen, setInspectOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [scrapReason, setScrapReason] = useState('');
  const [releaseNote, setReleaseNote] = useState('');
  const [acceptBalance, setAcceptBalance] = useState(false);

  const canInspect = order.allowedActions.includes('inspect');
  const canReview = order.allowedActions.includes('request_scrap_review');
  const canRelease = order.allowedActions.includes('release');
  const balanceBlocked = release.blockers.some(
    (blocker) => blocker.code === 'balance' || blocker.code === 'under_consumed'
  );

  const form = useForm<InspectValues>({
    resolver: zodResolver(inspectSchema),
    defaultValues: {
      result: 'pass',
      operationId: '',
      notes: '',
      reworkOperationName: '',
      checklist: [],
    },
  });
  const checklist = useFieldArray({ control: form.control, name: 'checklist' });
  const result = form.watch('result');

  async function uploadEvidence() {
    const problem = validateEvidenceFiles(files);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const file of files) {
        const outcome = await uploadFile(file, {
          target: {
            type: EVIDENCE_UPLOAD_TARGET,
            id: `${MANUFACTURING_OBJECT_TYPES.productionOrder}:${order.id}#photo`,
          },
        });
        if (outcome.status === 'ready') uploaded.push(outcome.objectId);
      }
      setEvidenceIds((current) => [...current, ...uploaded]);
      setFiles([]);
      toast.success(
        uploaded.length === 1 ? 'Evidencia adjuntada' : `${uploaded.length} evidencias adjuntadas`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir la evidencia');
    } finally {
      setUploading(false);
    }
  }

  const submitInspection = form.handleSubmit(async (values) => {
    const ok = await runAction(() =>
      inspectOrderAction({
        productionOrderId: order.id,
        result: values.result,
        ...(values.operationId ? { operationId: values.operationId } : {}),
        ...(values.notes ? { notes: values.notes } : {}),
        ...(values.checklist.length > 0
          ? {
              checklist: values.checklist.map((entry) => ({
                item: entry.item,
                ok: entry.ok,
                ...(entry.note ? { note: entry.note } : {}),
              })),
            }
          : {}),
        ...(evidenceIds.length > 0 ? { evidenceObjectIds: evidenceIds } : {}),
        ...(values.result === 'fail' && values.reworkOperationName
          ? { reworkOperationName: values.reworkOperationName }
          : {}),
      })
    );
    if (ok) {
      form.reset();
      setEvidenceIds([]);
      setInspectOpen(false);
    }
  });

  return (
    <section className="mfg-section" aria-labelledby="mfg-quality">
      <h2 id="mfg-quality" className="mfg-section-title">
        Calidad, merma y liberación
        <Badge variant={release.ready ? 'success' : 'warning'}>
          {release.ready ? 'Lista para liberar' : 'Aún no se puede liberar'}
        </Badge>
      </h2>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <h3 className="mfg-section-title">Inspecciones</h3>
      {qualityChecks.length === 0 ? (
        <p className="mfg-section-hint">Todavía no hay inspecciones registradas.</p>
      ) : (
        <ul className="area-evidence-list">
          {qualityChecks.map((check) => (
            <li key={check.id} className="area-evidence-item">
              <Badge
                variant={
                  check.result === 'pass'
                    ? 'success'
                    : check.result === 'fail'
                      ? 'danger'
                      : 'warning'
                }
              >
                {check.resultLabel}
              </Badge>
              {check.notes ?? 'Sin observaciones'}
              {check.checklist.length > 0 ? ` · ${check.checklist.length} puntos` : ''}
              {check.evidenceObjectIds.length > 0
                ? ` · ${check.evidenceObjectIds.length} evidencias`
                : ''}
            </li>
          ))}
        </ul>
      )}

      {canInspect ? (
        <div className="mfg-card-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() => setInspectOpen((open) => !open)}
          >
            Registrar inspección
          </Button>
        </div>
      ) : null}

      {inspectOpen ? (
        <form className="mfg-section" onSubmit={submitInspection} noValidate>
          <div className="mfg-grid-2">
            <FormField label="Resultado" htmlFor="mfg-inspect-result">
              <Select id="mfg-inspect-result" disabled={pending} {...form.register('result')}>
                <option value="pass">Aprobada</option>
                <option value="conditional">Aprobada con observaciones</option>
                <option value="fail">Rechazada</option>
              </Select>
            </FormField>
            <FormField
              label="Operación"
              htmlFor="mfg-inspect-operation"
              help="Vacío = inspección de toda la orden."
            >
              <Select
                id="mfg-inspect-operation"
                disabled={pending}
                {...form.register('operationId')}
              >
                <option value="">Toda la orden</option>
                {operations.map((operation) => (
                  <option key={operation.id} value={operation.id}>
                    {operation.seq}. {operation.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <FormField
            label={result === 'pass' ? 'Observaciones (opcional)' : 'Qué pasó'}
            htmlFor="mfg-inspect-notes"
            error={form.formState.errors.notes?.message ?? null}
          >
            <Textarea
              id="mfg-inspect-notes"
              rows={3}
              maxLength={2000}
              disabled={pending}
              {...form.register('notes')}
            />
          </FormField>

          {result === 'fail' ? (
            <FormField
              label="Nombre del retrabajo"
              htmlFor="mfg-inspect-rework"
              help="Se agrega como operación después de la que falló."
            >
              <Input
                id="mfg-inspect-rework"
                disabled={pending}
                placeholder="Retrabajo"
                {...form.register('reworkOperationName')}
              />
            </FormField>
          ) : null}

          {checklist.fields.map((field, index) => (
            <div key={field.id} className="mfg-line-row">
              <FormField
                label="Punto revisado"
                htmlFor={`mfg-check-item-${index}`}
                error={form.formState.errors.checklist?.[index]?.item?.message ?? null}
              >
                <Input
                  id={`mfg-check-item-${index}`}
                  disabled={pending}
                  {...form.register(`checklist.${index}.item`)}
                />
              </FormField>
              <FormField label="Nota" htmlFor={`mfg-check-note-${index}`}>
                <Input
                  id={`mfg-check-note-${index}`}
                  disabled={pending}
                  {...form.register(`checklist.${index}.note`)}
                />
              </FormField>
              <label className="mfg-day-toggle">
                <input
                  type="checkbox"
                  disabled={pending}
                  {...form.register(`checklist.${index}.ok`)}
                />
                Cumple
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Quitar el punto ${index + 1}`}
                disabled={pending}
                onClick={() => checklist.remove(index)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}

          <div className="mfg-card-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => checklist.append({ item: '', ok: true, note: '' })}
            >
              <Plus size={14} aria-hidden="true" />
              Agregar punto
            </Button>
          </div>

          <FormField
            label="Evidencia (fotos o documentos)"
            htmlFor="mfg-inspect-files"
            help={
              evidenceIds.length > 0
                ? `${evidenceIds.length} archivo(s) listos para la inspección.`
                : 'Adjunta y sube antes de registrar la inspección.'
            }
          >
            <input
              id="mfg-inspect-files"
              type="file"
              multiple
              accept="image/*,application/pdf"
              disabled={pending || uploading}
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
          </FormField>

          <div className="mfg-card-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending || uploading || files.length === 0}
              onClick={() => void uploadEvidence()}
            >
              <Upload size={14} aria-hidden="true" />
              {uploading ? 'Subiendo…' : 'Subir evidencia'}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending || uploading}>
              {pending ? 'Registrando…' : 'Registrar inspección'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setInspectOpen(false)}
            >
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}

      <h3 className="mfg-section-title">
        Merma
        <Badge variant={scrap.exceeded ? 'danger' : 'default'}>
          {SCRAP_APPROVAL_LABELS[scrapApproval]}
        </Badge>
      </h3>
      <p className="mfg-section-hint">
        Tolerancia {scrap.allowancePct} %
        {scrap.maxPct !== null
          ? ` · máximo registrado ${scrap.maxPct} %`
          : ' · sin merma registrada'}
        {scrap.pending ? ' · hay merma de un material sin consumo registrado' : ''}
      </p>

      {canReview && (scrap.exceeded || scrapApproval === 'stale') ? (
        <div className="mfg-inline-form">
          <FormField label="Motivo de la merma" htmlFor="mfg-scrap-reason">
            <Input
              id="mfg-scrap-reason"
              maxLength={500}
              value={scrapReason}
              disabled={pending}
              onChange={(event) => setScrapReason(event.target.value)}
            />
          </FormField>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || scrapReason.trim().length === 0}
            onClick={() =>
              void runAction(
                () =>
                  requestScrapReviewAction({
                    productionOrderId: order.id,
                    reason: scrapReason.trim(),
                  }),
                { onDone: () => setScrapReason('') }
              )
            }
          >
            Solicitar revisión
          </Button>
        </div>
      ) : null}

      <h3 className="mfg-section-title">Liberación</h3>
      {pendingSubstitutions > 0 ? (
        <Alert variant="warning">
          {pendingSubstitutions === 1
            ? 'Hay una sustitución de material esperando aprobación.'
            : `Hay ${pendingSubstitutions} sustituciones de material esperando aprobación.`}
        </Alert>
      ) : null}

      {release.blockers.length > 0 ? (
        <ul className="mfg-blockers">
          {release.blockers.map((blocker) => (
            <li key={`${blocker.code}-${blocker.message}`}>{blocker.message}</li>
          ))}
        </ul>
      ) : (
        <p className="mfg-section-hint">
          Nada la detiene: al liberar, la salida queda disponible para{' '}
          {order.releaseTargetLabel.toLowerCase()}.
        </p>
      )}

      {canRelease ? (
        <div className="mfg-inline-form">
          <FormField label="Nota de liberación" htmlFor="mfg-release-note">
            <Input
              id="mfg-release-note"
              maxLength={500}
              value={releaseNote}
              disabled={pending}
              onChange={(event) => setReleaseNote(event.target.value)}
            />
          </FormField>
          {balanceBlocked ? (
            <label className="mfg-day-toggle">
              <input
                type="checkbox"
                checked={acceptBalance}
                disabled={pending}
                onChange={(event) => setAcceptBalance(event.target.checked)}
              />
              Liberar aceptando la diferencia de balance
            </label>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() =>
              void runAction(() =>
                releaseOrderAction({
                  productionOrderId: order.id,
                  ...(releaseNote.trim() ? { note: releaseNote.trim() } : {}),
                  ...(acceptBalance ? { acceptBalanceDifference: true } : {}),
                })
              )
            }
          >
            Liberar orden
          </Button>
        </div>
      ) : null}
    </section>
  );
}
