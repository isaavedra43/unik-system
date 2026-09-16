'use client';

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import {
  activateBomAction,
  createBomAction,
  retireBomAction,
  updateBomAction,
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
import type { BomRow } from '@/modules/manufacturing/manufacturing-queries';
import { BOM_KINDS, BOM_KIND_LABELS } from '@/modules/manufacturing/manufacturing-types';
import { ItemPicker } from './ItemPicker';
import { useOrderAction } from './use-order-action';

export interface BomManagerProps {
  boms: BomRow[];
  centers: Array<{ id: string; name: string }>;
  /** `manufacturing.manage_boms`; without it the page is read only. */
  canManage: boolean;
}

/**
 * Listas de materiales versionadas (plan 6.2): sólo hacen falta para productos
 * repetibles — lo normal en UNIK es la orden de transformación, que lleva su
 * receta en memoria.
 *
 * Una revisión se edita mientras es borrador; al activarla, el servicio retira
 * la revisión activa anterior del mismo producto dentro de la misma transacción,
 * así que nunca hay dos activas.
 */

const schema = z.object({
  outputZohoItemId: z.string().trim().min(1, 'Indica el producto que produce la lista'),
  kind: z.enum(BOM_KINDS),
  outputQty: z.coerce.number().finite().positive('La cantidad debe ser mayor que cero'),
  outputUnit: z.string().trim().min(1, 'Indica la unidad de salida').max(40),
  expectedYield: z.string().trim().max(10),
  scrapAllowancePct: z.string().trim().max(10),
  notes: z.string().trim().max(2000),
  lines: z
    .array(
      z.object({
        inputZohoItemId: z.string().trim().min(1, 'Indica el insumo'),
        qtyPerOutput: z.coerce.number().finite().positive('Cantidad por unidad de salida'),
        unit: z.string().trim().min(1, 'Unidad del insumo').max(40),
        scrapPct: z.string().trim().max(10),
        substitutes: z.string().trim().max(400),
      })
    )
    .min(1, 'La lista necesita al menos un insumo'),
  operations: z.array(
    z.object({
      seq: z.coerce.number().int().min(1).max(999),
      workCenterId: z.string().trim().min(1, 'Elige el centro de trabajo'),
      name: z.string().trim().min(1, 'Nombre de la operación').max(120),
      stdMinutes: z.coerce.number().int().min(0).max(100000),
      setupMinutes: z.coerce.number().int().min(0).max(100000),
      qcRequired: z.boolean(),
    })
  ),
});

type FormValues = z.output<typeof schema>;

const EMPTY: FormValues = {
  outputZohoItemId: '',
  kind: 'assembly',
  outputQty: 1,
  outputUnit: '',
  expectedYield: '',
  scrapAllowancePct: '',
  notes: '',
  lines: [{ inputZohoItemId: '', qtyPerOutput: 1, unit: '', scrapPct: '', substitutes: '' }],
  operations: [],
};

const STATUS_BADGE = { draft: 'weak', active: 'success', retired: 'default' } as const;

function parseSubstitutes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 10)
    ),
  ];
}

export function BomManager({ boms, centers, canManage }: BomManagerProps) {
  const { runAction, pending, error } = useOrderAction();
  const [editing, setEditing] = useState<BomRow | null>(null);
  const [open, setOpen] = useState(false);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const operations = useFieldArray({ control: form.control, name: 'operations' });

  function startCreate() {
    setEditing(null);
    form.reset(EMPTY);
    setOpen(true);
  }

  function startEdit(bom: BomRow) {
    setEditing(bom);
    form.reset({
      outputZohoItemId: bom.outputZohoItemId,
      kind: bom.kind as FormValues['kind'],
      outputQty: Number(bom.outputQty) || 1,
      outputUnit: bom.outputUnit,
      expectedYield: bom.expectedYield ?? '',
      scrapAllowancePct: bom.scrapAllowancePct ?? '',
      notes: bom.notes ?? '',
      lines: bom.lines.map((line) => ({
        inputZohoItemId: line.inputZohoItemId,
        qtyPerOutput: Number(line.qtyPerOutput) || 1,
        unit: line.unit,
        scrapPct: line.scrapPct ?? '',
        substitutes: line.substituteZohoItemIds.join(', '),
      })),
      operations: bom.operations.map((operation) => ({
        seq: operation.seq,
        workCenterId: operation.workCenterId,
        name: operation.name,
        stdMinutes: operation.stdMinutes,
        setupMinutes: operation.setupMinutes,
        qcRequired: operation.qcRequired,
      })),
    });
    setOpen(true);
  }

  const submit = form.handleSubmit(async (values) => {
    const definition = {
      kind: values.kind,
      outputQty: values.outputQty,
      outputUnit: values.outputUnit,
      ...(values.expectedYield.trim() ? { expectedYield: Number(values.expectedYield) } : {}),
      ...(values.scrapAllowancePct.trim()
        ? { scrapAllowancePct: Number(values.scrapAllowancePct) }
        : {}),
      ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
      lines: values.lines.map((line) => ({
        inputZohoItemId: line.inputZohoItemId,
        qtyPerOutput: line.qtyPerOutput,
        unit: line.unit,
        substituteZohoItemIds: parseSubstitutes(line.substitutes),
        ...(line.scrapPct.trim() ? { scrapPct: Number(line.scrapPct) } : {}),
      })),
      operations: values.operations.map((operation) => ({
        seq: operation.seq,
        workCenterId: operation.workCenterId,
        name: operation.name,
        stdMinutes: operation.stdMinutes,
        setupMinutes: operation.setupMinutes,
        qcRequired: operation.qcRequired,
      })),
    };
    const ok = await runAction(() =>
      editing
        ? updateBomAction({ bomId: editing.id, ...definition })
        : createBomAction({ outputZohoItemId: values.outputZohoItemId, ...definition })
    );
    if (ok) {
      setOpen(false);
      setEditing(null);
      form.reset(EMPTY);
    }
  });

  return (
    <div className="mfg-order">
      {error ? <Alert variant="error">{error}</Alert> : null}

      <section className="mfg-section">
        <h2 className="mfg-section-title">
          Listas de materiales
          {canManage ? (
            <Button variant="primary" size="sm" disabled={pending} onClick={startCreate}>
              <Plus size={14} aria-hidden="true" />
              Nueva lista
            </Button>
          ) : null}
        </h2>

        {boms.length === 0 ? (
          <div className="mfg-empty">
            <strong>Todavía no hay listas de materiales</strong>
            <p>
              No hacen falta para producir: una orden de transformación lleva su receta consigo.
              Crea una lista sólo cuando un producto se repita con la misma receta y la misma ruta.
            </p>
          </div>
        ) : (
          <div className="mfg-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Producto</th>
                  <th scope="col">Revisión</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Insumos</th>
                  <th scope="col">Operaciones</th>
                  <th scope="col">Estado</th>
                  {canManage ? <th scope="col">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {boms.map((bom) => (
                  <tr key={bom.id}>
                    <td>
                      {bom.outputName ?? bom.outputZohoItemId}
                      <div className="area-row-sub">{bom.outputSku ?? bom.outputZohoItemId}</div>
                    </td>
                    <td>
                      v{bom.version} · {bom.outputQty} {bom.outputUnit}
                    </td>
                    <td>{bom.kindLabel}</td>
                    <td>{bom.lines.length}</td>
                    <td>{bom.operations.length}</td>
                    <td>
                      <Badge
                        variant={STATUS_BADGE[bom.status as keyof typeof STATUS_BADGE] ?? 'default'}
                      >
                        {bom.statusLabel}
                      </Badge>
                    </td>
                    {canManage ? (
                      <td>
                        <span className="mfg-card-actions">
                          {bom.status === 'draft' ? (
                            <>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={pending}
                                onClick={() => startEdit(bom)}
                              >
                                Editar
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={pending}
                                onClick={() =>
                                  void runAction(() => activateBomAction({ bomId: bom.id }))
                                }
                              >
                                Activar
                              </Button>
                            </>
                          ) : null}
                          {bom.status === 'active' ? (
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={pending}
                              onClick={() =>
                                void runAction(() => retireBomAction({ bomId: bom.id }))
                              }
                            >
                              Retirar
                            </Button>
                          ) : null}
                        </span>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage && open ? (
        <form className="mfg-section" onSubmit={submit} noValidate>
          <h2 className="mfg-section-title">
            {editing ? `Editar revisión v${editing.version}` : 'Nueva lista de materiales'}
          </h2>

          <div className="mfg-grid-3">
            <FormField
              label="Producto de salida"
              htmlFor="mfg-bom-output"
              error={form.formState.errors.outputZohoItemId?.message ?? null}
              help={editing ? 'No cambia entre revisiones.' : undefined}
            >
              {editing ? (
                <Input
                  id="mfg-bom-output"
                  value={editing.outputName ?? editing.outputZohoItemId}
                  readOnly
                  disabled
                />
              ) : (
                <ItemPicker
                  id="mfg-bom-output"
                  value={form.watch('outputZohoItemId')}
                  disabled={pending}
                  onChange={(item, raw) => {
                    form.setValue('outputZohoItemId', item ? item.zohoItemId : raw, {
                      shouldValidate: true,
                    });
                    if (item?.unit && !form.getValues('outputUnit')) {
                      form.setValue('outputUnit', item.unit);
                    }
                  }}
                />
              )}
            </FormField>
            <FormField
              label="Cantidad de salida"
              htmlFor="mfg-bom-qty"
              error={form.formState.errors.outputQty?.message ?? null}
              help="El lote que produce esta receta."
            >
              <Input
                id="mfg-bom-qty"
                type="number"
                step="any"
                min={0}
                disabled={pending}
                {...form.register('outputQty')}
              />
            </FormField>
            <FormField
              label="Unidad"
              htmlFor="mfg-bom-unit"
              error={form.formState.errors.outputUnit?.message ?? null}
            >
              <Input id="mfg-bom-unit" disabled={pending} {...form.register('outputUnit')} />
            </FormField>
          </div>

          <div className="mfg-grid-3">
            <FormField label="Tipo" htmlFor="mfg-bom-kind">
              <Select id="mfg-bom-kind" disabled={pending} {...form.register('kind')}>
                {BOM_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {BOM_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Rendimiento esperado"
              htmlFor="mfg-bom-yield"
              help="Fracción de 0 a 1 (0.95 = 95 %)."
            >
              <Input
                id="mfg-bom-yield"
                type="number"
                step="any"
                min={0}
                max={1}
                disabled={pending}
                {...form.register('expectedYield')}
              />
            </FormField>
            <FormField label="Tolerancia de merma (%)" htmlFor="mfg-bom-scrap">
              <Input
                id="mfg-bom-scrap"
                type="number"
                step="any"
                min={0}
                max={100}
                disabled={pending}
                {...form.register('scrapAllowancePct')}
              />
            </FormField>
          </div>

          <h3 className="mfg-section-title">Insumos</h3>
          {lines.fields.map((field, index) => (
            <div key={field.id} className="mfg-line-row">
              <FormField
                label="Insumo"
                htmlFor={`mfg-bom-line-${index}`}
                error={form.formState.errors.lines?.[index]?.inputZohoItemId?.message ?? null}
              >
                <ItemPicker
                  id={`mfg-bom-line-${index}`}
                  value={form.watch(`lines.${index}.inputZohoItemId`)}
                  disabled={pending}
                  onChange={(item, raw) =>
                    form.setValue(`lines.${index}.inputZohoItemId`, item ? item.zohoItemId : raw, {
                      shouldValidate: true,
                    })
                  }
                />
              </FormField>
              <FormField
                label="Por unidad de salida"
                htmlFor={`mfg-bom-line-qty-${index}`}
                error={form.formState.errors.lines?.[index]?.qtyPerOutput?.message ?? null}
              >
                <Input
                  id={`mfg-bom-line-qty-${index}`}
                  type="number"
                  step="any"
                  min={0}
                  disabled={pending}
                  {...form.register(`lines.${index}.qtyPerOutput`)}
                />
              </FormField>
              <FormField
                label="Unidad"
                htmlFor={`mfg-bom-line-unit-${index}`}
                error={form.formState.errors.lines?.[index]?.unit?.message ?? null}
              >
                <Input
                  id={`mfg-bom-line-unit-${index}`}
                  disabled={pending}
                  {...form.register(`lines.${index}.unit`)}
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Quitar el insumo ${index + 1}`}
                disabled={pending || lines.fields.length === 1}
                onClick={() => lines.remove(index)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
              <FormField
                label="Sustitutos permitidos"
                htmlFor={`mfg-bom-line-sub-${index}`}
                help="Ids de producto separados por coma; consumirlos no pide aprobación."
              >
                <Input
                  id={`mfg-bom-line-sub-${index}`}
                  disabled={pending}
                  {...form.register(`lines.${index}.substitutes`)}
                />
              </FormField>
              <FormField label="Merma esperada (%)" htmlFor={`mfg-bom-line-scrap-${index}`}>
                <Input
                  id={`mfg-bom-line-scrap-${index}`}
                  type="number"
                  step="any"
                  min={0}
                  max={100}
                  disabled={pending}
                  {...form.register(`lines.${index}.scrapPct`)}
                />
              </FormField>
            </div>
          ))}

          <div className="mfg-card-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                lines.append({
                  inputZohoItemId: '',
                  qtyPerOutput: 1,
                  unit: '',
                  scrapPct: '',
                  substitutes: '',
                })
              }
            >
              <Plus size={14} aria-hidden="true" />
              Agregar insumo
            </Button>
          </div>

          <h3 className="mfg-section-title">Ruta (opcional)</h3>
          <p className="mfg-section-hint">
            Sin ruta, la orden crea una sola operación de producción. Con ruta, cada operación se
            programa en su centro y puede exigir inspección antes de continuar.
          </p>

          {operations.fields.map((field, index) => (
            <div key={field.id} className="mfg-shift-row">
              <FormField
                label="Operación"
                htmlFor={`mfg-bom-op-name-${index}`}
                error={form.formState.errors.operations?.[index]?.name?.message ?? null}
              >
                <Input
                  id={`mfg-bom-op-name-${index}`}
                  disabled={pending}
                  {...form.register(`operations.${index}.name`)}
                />
              </FormField>
              <FormField label="Secuencia" htmlFor={`mfg-bom-op-seq-${index}`}>
                <Input
                  id={`mfg-bom-op-seq-${index}`}
                  type="number"
                  min={1}
                  max={999}
                  disabled={pending}
                  {...form.register(`operations.${index}.seq`)}
                />
              </FormField>
              <FormField label="Minutos estándar" htmlFor={`mfg-bom-op-std-${index}`}>
                <Input
                  id={`mfg-bom-op-std-${index}`}
                  type="number"
                  min={0}
                  disabled={pending}
                  {...form.register(`operations.${index}.stdMinutes`)}
                />
              </FormField>
              <FormField
                label="Centro de trabajo"
                htmlFor={`mfg-bom-op-center-${index}`}
                error={form.formState.errors.operations?.[index]?.workCenterId?.message ?? null}
              >
                <Select
                  id={`mfg-bom-op-center-${index}`}
                  disabled={pending}
                  {...form.register(`operations.${index}.workCenterId`)}
                >
                  <option value="">Elige un centro…</option>
                  {centers.map((center) => (
                    <option key={center.id} value={center.id}>
                      {center.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Quitar la operación ${index + 1}`}
                disabled={pending}
                onClick={() => operations.remove(index)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
              <label className="mfg-day-toggle">
                <input
                  type="checkbox"
                  disabled={pending}
                  {...form.register(`operations.${index}.qcRequired`)}
                />
                Requiere inspección
              </label>
            </div>
          ))}

          <div className="mfg-card-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || centers.length === 0}
              onClick={() =>
                operations.append({
                  seq: operations.fields.length + 1,
                  workCenterId: '',
                  name: '',
                  stdMinutes: 0,
                  setupMinutes: 0,
                  qcRequired: false,
                })
              }
            >
              <Plus size={14} aria-hidden="true" />
              Agregar operación
            </Button>
            {centers.length === 0 ? (
              <span className="mfg-section-hint">
                Necesitas al menos un centro de trabajo para definir una ruta.
              </span>
            ) : null}
          </div>

          <FormField label="Notas" htmlFor="mfg-bom-notes">
            <Textarea id="mfg-bom-notes" rows={2} disabled={pending} {...form.register('notes')} />
          </FormField>

          <div className="mfg-card-actions">
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? 'Guardando…' : editing ? 'Guardar borrador' : 'Crear lista'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setEditing(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
