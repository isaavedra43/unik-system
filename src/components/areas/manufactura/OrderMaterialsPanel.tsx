'use client';

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { recordConsumptionAction, recordOutputAction } from '@/app/app/manufacturing/actions';
import { Alert, Badge, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type {
  MaterialConsumptionDTO,
  ProductionOutputDTO,
} from '@/modules/manufacturing/manufacturing-dto';
import type {
  MaterialStatusRow,
  ProductionOrderRow,
} from '@/modules/manufacturing/manufacturing-queries';
import type { MaterialBalance } from '@/modules/manufacturing/scrap-rules';
import { ItemPicker } from './ItemPicker';
import { useOrderAction } from './use-order-action';

export interface OrderMaterialsPanelProps {
  order: ProductionOrderRow;
  materials: MaterialStatusRow[];
  consumptions: MaterialConsumptionDTO[];
  outputs: ProductionOutputDTO[];
  balance: MaterialBalance;
}

/**
 * Material of a production order: what was committed, what the floor actually
 * consumed, and what came out of it (finished goods, saleable leftovers and
 * scrap).
 *
 * Both forms mirror the schemas of the module (`recordConsumptionSchema`,
 * `recordOutputSchema`) so the person is told what is wrong BEFORE sending; the
 * command validates everything again and owns the real rules — a substitution
 * outside the bill of materials, for instance, opens its approval by itself.
 */

const consumptionSchema = z.object({
  lines: z
    .array(
      z.object({
        zohoItemId: z.string().trim().min(1, 'Indica el material'),
        qty: z.coerce.number().finite().positive('La cantidad debe ser mayor que cero'),
        unit: z.string().trim().max(40),
        substituteFor: z.string().trim().max(120),
      })
    )
    .min(1, 'Agrega al menos un material'),
  note: z.string().trim().max(500),
});
type ConsumptionValues = z.output<typeof consumptionSchema>;

const outputSchema = z
  .object({
    kind: z.enum(['finished', 'leftover', 'scrap']),
    zohoItemId: z.string().trim().max(120),
    qty: z.coerce.number().finite().positive('La cantidad debe ser mayor que cero'),
    unit: z.string().trim().max(40),
    locationCode: z.string().trim().max(40),
    reason: z.string().trim().max(500),
    largo: z.string().trim().max(20),
    ancho: z.string().trim().max(20),
    espesor: z.string().trim().max(20),
    unidadMedida: z.string().trim().max(10),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'leftover') return;
    const largo = Number(value.largo);
    if (!Number.isFinite(largo) || largo <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['largo'],
        message: 'Registra el largo del sobrante',
      });
    }
    if (!value.unidadMedida.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unidadMedida'],
        message: 'Indica la unidad de las medidas',
      });
    }
  });
type OutputValues = z.output<typeof outputSchema>;

const OUTPUT_LABELS: Record<OutputValues['kind'], string> = {
  finished: 'Producto terminado',
  leftover: 'Sobrante vendible',
  scrap: 'Merma',
};

export function OrderMaterialsPanel({
  order,
  materials,
  consumptions,
  outputs,
  balance,
}: OrderMaterialsPanelProps) {
  const { runAction, pending, error } = useOrderAction();
  const [consumptionOpen, setConsumptionOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

  const canConsume = order.allowedActions.includes('record_consumption');
  const canFinished = order.allowedActions.includes('record_finished_output');
  const canOther = order.allowedActions.includes('record_other_output');

  const consumptionForm = useForm<ConsumptionValues>({
    resolver: zodResolver(consumptionSchema),
    defaultValues: { lines: [{ zohoItemId: '', qty: 0, unit: '', substituteFor: '' }], note: '' },
  });
  const lines = useFieldArray({ control: consumptionForm.control, name: 'lines' });

  const outputForm = useForm<OutputValues>({
    resolver: zodResolver(outputSchema),
    defaultValues: {
      kind: canFinished ? 'finished' : 'scrap',
      zohoItemId: '',
      qty: 0,
      unit: '',
      locationCode: '',
      reason: '',
      largo: '',
      ancho: '',
      espesor: '',
      unidadMedida: 'm',
    },
  });
  const outputKind = outputForm.watch('kind');

  const submitConsumption = consumptionForm.handleSubmit(async (values) => {
    const ok = await runAction(() =>
      recordConsumptionAction({
        productionOrderId: order.id,
        lines: values.lines.map((line) => ({
          zohoItemId: line.zohoItemId,
          qty: line.qty,
          ...(line.unit ? { unit: line.unit } : {}),
          ...(line.substituteFor ? { substituteFor: line.substituteFor } : {}),
        })),
        ...(values.note ? { note: values.note } : {}),
      })
    );
    if (ok) {
      consumptionForm.reset();
      setConsumptionOpen(false);
    }
  });

  const submitOutput = outputForm.handleSubmit(async (values) => {
    const ok = await runAction(() =>
      recordOutputAction({
        productionOrderId: order.id,
        kind: values.kind,
        qty: values.qty,
        ...(values.zohoItemId ? { zohoItemId: values.zohoItemId } : {}),
        ...(values.unit ? { unit: values.unit } : {}),
        ...(values.locationCode ? { locationCode: values.locationCode } : {}),
        ...(values.reason ? { reason: values.reason } : {}),
        ...(values.kind === 'leftover'
          ? {
              dimensions: {
                largo: Number(values.largo),
                ...(values.ancho ? { ancho: Number(values.ancho) } : {}),
                ...(values.espesor ? { espesor: Number(values.espesor) } : {}),
                unidad: values.unidadMedida,
              },
            }
          : {}),
      })
    );
    if (ok) {
      outputForm.reset({ ...outputForm.getValues(), qty: 0, largo: '', ancho: '', espesor: '' });
      setOutputOpen(false);
    }
  });

  return (
    <section className="mfg-section" aria-labelledby="mfg-materials">
      <h2 id="mfg-materials" className="mfg-section-title">
        Material y salidas
        {!balance.balanced && balance.comparable ? (
          <Badge variant="warning">El balance no cuadra</Badge>
        ) : null}
      </h2>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {materials.length === 0 ? (
        <p className="mfg-section-hint">
          La orden todavía no tiene material asignado: resérvalo para apartar los insumos.
        </p>
      ) : (
        <div className="mfg-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Insumo</th>
                <th scope="col">Requerido</th>
                <th scope="col">Asignado</th>
                <th scope="col">Retenido</th>
                <th scope="col">Consumido</th>
                <th scope="col">Sobrante</th>
                <th scope="col">Merma</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={material.zohoItemId}>
                  <td>
                    {material.label}
                    {material.substitutes.length > 0 ? (
                      <div className="area-row-sub">
                        Sustitutos permitidos: {material.substitutes.length}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {material.required} {material.baseUnit}
                  </td>
                  <td>{material.assigned}</td>
                  <td>{material.held}</td>
                  <td>{material.consumed}</td>
                  <td>{material.leftover}</td>
                  <td>{material.scrap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mfg-card-actions">
        {canConsume ? (
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() => setConsumptionOpen((open) => !open)}
          >
            <Plus size={14} aria-hidden="true" />
            Registrar consumo
          </Button>
        ) : null}
        {canFinished || canOther ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => setOutputOpen((open) => !open)}
          >
            <Plus size={14} aria-hidden="true" />
            Registrar salida
          </Button>
        ) : null}
      </div>

      {consumptionOpen ? (
        <form className="mfg-section" onSubmit={submitConsumption} noValidate>
          <h3 className="mfg-section-title">Consumo real</h3>
          <p className="mfg-section-hint">
            Lo que se usó en el piso. Si el material no está en la orden, indica a qué insumo
            sustituye: una sustitución fuera de la lista abre su aprobación antes de contabilizarse.
          </p>

          {lines.fields.map((field, index) => (
            <div key={field.id} className="mfg-line-row">
              <FormField
                label="Material"
                htmlFor={`mfg-line-item-${index}`}
                error={consumptionForm.formState.errors.lines?.[index]?.zohoItemId?.message ?? null}
              >
                <ItemPicker
                  id={`mfg-line-item-${index}`}
                  value={consumptionForm.watch(`lines.${index}.zohoItemId`)}
                  disabled={pending}
                  onChange={(item, raw) =>
                    consumptionForm.setValue(
                      `lines.${index}.zohoItemId`,
                      item ? item.zohoItemId : raw,
                      { shouldValidate: true }
                    )
                  }
                />
              </FormField>
              <FormField
                label="Cantidad"
                htmlFor={`mfg-line-qty-${index}`}
                error={consumptionForm.formState.errors.lines?.[index]?.qty?.message ?? null}
              >
                <Input
                  id={`mfg-line-qty-${index}`}
                  type="number"
                  step="any"
                  min={0}
                  disabled={pending}
                  {...consumptionForm.register(`lines.${index}.qty`)}
                />
              </FormField>
              <FormField label="Unidad" htmlFor={`mfg-line-unit-${index}`}>
                <Input
                  id={`mfg-line-unit-${index}`}
                  placeholder="la del insumo"
                  disabled={pending}
                  {...consumptionForm.register(`lines.${index}.unit`)}
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Quitar el material ${index + 1}`}
                disabled={pending || lines.fields.length === 1}
                onClick={() => lines.remove(index)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
              <FormField label="Sustituye a (opcional)" htmlFor={`mfg-line-sub-${index}`}>
                <Select
                  id={`mfg-line-sub-${index}`}
                  disabled={pending}
                  {...consumptionForm.register(`lines.${index}.substituteFor`)}
                >
                  <option value="">No sustituye a nadie</option>
                  {materials.map((material) => (
                    <option key={material.zohoItemId} value={material.zohoItemId}>
                      {material.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          ))}

          <div className="mfg-card-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => lines.append({ zohoItemId: '', qty: 0, unit: '', substituteFor: '' })}
            >
              <Plus size={14} aria-hidden="true" />
              Agregar material
            </Button>
          </div>

          <FormField label="Nota" htmlFor="mfg-consumption-note">
            <Input
              id="mfg-consumption-note"
              maxLength={500}
              disabled={pending}
              {...consumptionForm.register('note')}
            />
          </FormField>

          <div className="mfg-card-actions">
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? 'Registrando…' : 'Registrar consumo'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConsumptionOpen(false)}
            >
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}

      <h3 className="mfg-section-title">Salidas</h3>
      {outputs.length === 0 ? (
        <p className="mfg-section-hint">Todavía no se registra ninguna salida de esta orden.</p>
      ) : (
        <div className="mfg-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Producto</th>
                <th scope="col">Cantidad</th>
                <th scope="col">Medidas</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((output) => (
                <tr key={output.id}>
                  <td>{output.kindLabel}</td>
                  <td>{output.zohoItemId}</td>
                  <td>
                    {output.qty} {output.unit}
                  </td>
                  <td>
                    {output.dimensions
                      ? Object.entries(output.dimensions)
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(' · ')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {outputOpen ? (
        <form className="mfg-section" onSubmit={submitOutput} noValidate>
          <h3 className="mfg-section-title">Nueva salida</h3>
          <div className="mfg-grid-3">
            <FormField label="Tipo" htmlFor="mfg-output-kind">
              <Select id="mfg-output-kind" disabled={pending} {...outputForm.register('kind')}>
                {(Object.keys(OUTPUT_LABELS) as OutputValues['kind'][])
                  .filter((kind) => (kind === 'finished' ? canFinished : canOther))
                  .map((kind) => (
                    <option key={kind} value={kind}>
                      {OUTPUT_LABELS[kind]}
                    </option>
                  ))}
              </Select>
            </FormField>
            <FormField
              label="Cantidad"
              htmlFor="mfg-output-qty"
              error={outputForm.formState.errors.qty?.message ?? null}
            >
              <Input
                id="mfg-output-qty"
                type="number"
                step="any"
                min={0}
                disabled={pending}
                {...outputForm.register('qty')}
              />
            </FormField>
            <FormField label="Unidad" htmlFor="mfg-output-unit">
              <Input
                id="mfg-output-unit"
                placeholder="la del producto"
                disabled={pending}
                {...outputForm.register('unit')}
              />
            </FormField>
          </div>

          <div className="mfg-grid-2">
            <FormField
              label="Producto"
              htmlFor="mfg-output-item"
              help={
                outputKind === 'finished'
                  ? 'Vacío = el producto de salida de la orden.'
                  : 'Vacío = el insumo de la orden.'
              }
            >
              <ItemPicker
                id="mfg-output-item"
                value={outputForm.watch('zohoItemId')}
                disabled={pending}
                onChange={(item, raw) =>
                  outputForm.setValue('zohoItemId', item ? item.zohoItemId : raw)
                }
              />
            </FormField>
            <FormField
              label="Ubicación"
              htmlFor="mfg-output-location"
              help={
                outputKind === 'scrap'
                  ? 'La merma siempre va a la ubicación SCRAP.'
                  : 'Código de la ubicación destino (opcional).'
              }
            >
              <Input
                id="mfg-output-location"
                disabled={pending || outputKind === 'scrap'}
                {...outputForm.register('locationCode')}
              />
            </FormField>
          </div>

          {outputKind === 'leftover' ? (
            <div className="mfg-grid-3">
              <FormField
                label="Largo"
                htmlFor="mfg-output-largo"
                error={outputForm.formState.errors.largo?.message ?? null}
              >
                <Input
                  id="mfg-output-largo"
                  type="number"
                  step="any"
                  min={0}
                  disabled={pending}
                  {...outputForm.register('largo')}
                />
              </FormField>
              <FormField label="Ancho" htmlFor="mfg-output-ancho">
                <Input
                  id="mfg-output-ancho"
                  type="number"
                  step="any"
                  min={0}
                  disabled={pending}
                  {...outputForm.register('ancho')}
                />
              </FormField>
              <FormField
                label="Unidad de las medidas"
                htmlFor="mfg-output-unidad"
                error={outputForm.formState.errors.unidadMedida?.message ?? null}
              >
                <Input
                  id="mfg-output-unidad"
                  disabled={pending}
                  {...outputForm.register('unidadMedida')}
                />
              </FormField>
            </div>
          ) : null}

          <FormField label="Motivo / nota" htmlFor="mfg-output-reason">
            <Input id="mfg-output-reason" disabled={pending} {...outputForm.register('reason')} />
          </FormField>

          <div className="mfg-card-actions">
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? 'Registrando…' : 'Registrar salida'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setOutputOpen(false)}
            >
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}

      {consumptions.length > 0 ? (
        <p className="mfg-section-hint">
          {consumptions.filter((entry) => entry.posted).length} consumos contabilizados ·{' '}
          {consumptions.filter((entry) => entry.approvalRequestId && !entry.posted).length}{' '}
          esperando aprobación
        </p>
      ) : null}
    </section>
  );
}
