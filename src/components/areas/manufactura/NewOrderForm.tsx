'use client';

import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { createTransformationOrderAction } from '@/app/app/manufacturing/actions';
import { Alert, Button, FormField, Input, Select } from '@/components/ui/primitives';
import { productionOrderUrl } from '@/modules/manufacturing/manufacturing-types';
import { ItemPicker } from './ItemPicker';
import { useOrderAction } from './use-order-action';

export interface NewOrderFormProps {
  centers: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
}

/**
 * Orden de transformación rápida (plan 6.2: the default way Manufactura works):
 * one input material becomes one output product plus its scrap, with an implicit
 * bill of materials kept in memory and a single "corte/acabado" operation.
 *
 * The form only collects what `createTransformationOrderSchema` accepts; the
 * command creates the order, its operation and — when asked — commits the
 * material, raising the shortfall request to Compras by itself.
 */

const schema = z
  .object({
    outputZohoItemId: z.string().trim().min(1, 'Indica el producto que sale'),
    outputName: z.string().trim().max(300),
    plannedQty: z.coerce.number().finite().positive('La cantidad debe ser mayor que cero'),
    plannedUnit: z.string().trim().max(40),
    inputs: z
      .array(
        z.object({
          zohoItemId: z.string().trim().min(1, 'Indica el material de entrada'),
          qty: z.coerce.number().finite().positive('La cantidad debe ser mayor que cero'),
          unit: z.string().trim().max(40),
        })
      )
      .min(1, 'Indica al menos un material de entrada'),
    outputWarehouseId: z.string().trim().min(1, 'Elige la bodega donde se libera'),
    workCenterId: z.string().trim().max(120),
    plannedStartAt: z.string().trim().max(40),
    priority: z.enum(['normal', 'high', 'urgent']),
    releaseTarget: z.enum(['inventory', 'logistics']),
    scrapAllowancePct: z.string().trim().max(10),
    operationName: z.string().trim().max(120),
    allowSameItem: z.boolean(),
    reserveNow: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const sameItem = value.inputs.some((input) => input.zohoItemId === value.outputZohoItemId);
    if (sameItem && !value.allowSameItem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowSameItem'],
        message:
          'La entrada y la salida son el mismo artículo: confirma que es un corte a medida del mismo producto.',
      });
    }
    if (value.scrapAllowancePct.trim()) {
      const pct = Number(value.scrapAllowancePct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scrapAllowancePct'],
          message: 'La tolerancia va de 0 a 100 %',
        });
      }
    }
  });

type FormValues = z.output<typeof schema>;

export function NewOrderForm({ centers, warehouses }: NewOrderFormProps) {
  const router = useRouter();
  const { runAction, pending, error } = useOrderAction();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      outputZohoItemId: '',
      outputName: '',
      plannedQty: 0,
      plannedUnit: '',
      inputs: [{ zohoItemId: '', qty: 0, unit: '' }],
      outputWarehouseId: warehouses[0]?.id ?? '',
      workCenterId: '',
      plannedStartAt: '',
      priority: 'normal',
      releaseTarget: 'inventory',
      scrapAllowancePct: '',
      operationName: '',
      allowSameItem: false,
      reserveNow: true,
    },
  });
  const inputs = useFieldArray({ control: form.control, name: 'inputs' });

  const submit = form.handleSubmit(async (values) => {
    let createdId: string | null = null;
    await runAction(async () => {
      const result = await createTransformationOrderAction({
        outputZohoItemId: values.outputZohoItemId,
        ...(values.outputName ? { outputName: values.outputName } : {}),
        plannedQty: values.plannedQty,
        ...(values.plannedUnit ? { plannedUnit: values.plannedUnit } : {}),
        inputs: values.inputs.map((input) => ({
          zohoItemId: input.zohoItemId,
          qty: input.qty,
          ...(input.unit ? { unit: input.unit } : {}),
        })),
        outputWarehouseId: values.outputWarehouseId,
        ...(values.workCenterId ? { workCenterId: values.workCenterId } : {}),
        ...(values.plannedStartAt
          ? { plannedStartAt: new Date(values.plannedStartAt).toISOString() }
          : {}),
        priority: values.priority,
        releaseTarget: values.releaseTarget,
        ...(values.scrapAllowancePct.trim()
          ? { scrapAllowancePct: Number(values.scrapAllowancePct) }
          : {}),
        ...(values.operationName ? { operationName: values.operationName } : {}),
        ...(values.allowSameItem ? { allowSameItem: true } : {}),
        reserveNow: values.reserveNow,
      });
      createdId = result.productionOrderId;
      return { ok: result.ok, message: result.message };
    });
    if (createdId) router.push(productionOrderUrl(createdId));
  });

  if (warehouses.length === 0) {
    return (
      <div className="mfg-empty">
        <strong>Falta una bodega activa</strong>
        <p>
          Una orden de producción necesita la bodega donde entregará su salida. Pide a Inventario
          que active al menos una bodega y vuelve a intentarlo.
        </p>
      </div>
    );
  }

  return (
    <form className="mfg-order" onSubmit={submit} noValidate>
      {error ? <Alert variant="error">{error}</Alert> : null}

      <section className="mfg-section">
        <h2 className="mfg-section-title">Qué se produce</h2>
        <div className="mfg-grid-3">
          <FormField
            label="Producto de salida"
            htmlFor="mfg-new-output"
            error={form.formState.errors.outputZohoItemId?.message ?? null}
          >
            <ItemPicker
              id="mfg-new-output"
              value={form.watch('outputZohoItemId')}
              disabled={pending}
              required
              onChange={(item, raw) => {
                form.setValue('outputZohoItemId', item ? item.zohoItemId : raw, {
                  shouldValidate: true,
                });
                if (item?.unit && !form.getValues('plannedUnit')) {
                  form.setValue('plannedUnit', item.unit);
                }
              }}
            />
          </FormField>
          <FormField
            label="Cantidad"
            htmlFor="mfg-new-qty"
            error={form.formState.errors.plannedQty?.message ?? null}
          >
            <Input
              id="mfg-new-qty"
              type="number"
              step="any"
              min={0}
              disabled={pending}
              {...form.register('plannedQty')}
            />
          </FormField>
          <FormField
            label="Unidad"
            htmlFor="mfg-new-unit"
            help="Vacío = la unidad base del producto."
          >
            <Input id="mfg-new-unit" disabled={pending} {...form.register('plannedUnit')} />
          </FormField>
        </div>
        <FormField
          label="Nombre para la orden (opcional)"
          htmlFor="mfg-new-name"
          help="Útil cuando el corte tiene un nombre propio en el piso."
        >
          <Input id="mfg-new-name" disabled={pending} {...form.register('outputName')} />
        </FormField>
      </section>

      <section className="mfg-section">
        <h2 className="mfg-section-title">Con qué material</h2>
        {inputs.fields.map((field, index) => (
          <div key={field.id} className="mfg-line-row">
            <FormField
              label="Material de entrada"
              htmlFor={`mfg-new-input-${index}`}
              error={form.formState.errors.inputs?.[index]?.zohoItemId?.message ?? null}
            >
              <ItemPicker
                id={`mfg-new-input-${index}`}
                value={form.watch(`inputs.${index}.zohoItemId`)}
                disabled={pending}
                onChange={(item, raw) =>
                  form.setValue(`inputs.${index}.zohoItemId`, item ? item.zohoItemId : raw, {
                    shouldValidate: true,
                  })
                }
              />
            </FormField>
            <FormField
              label="Cantidad"
              htmlFor={`mfg-new-input-qty-${index}`}
              error={form.formState.errors.inputs?.[index]?.qty?.message ?? null}
            >
              <Input
                id={`mfg-new-input-qty-${index}`}
                type="number"
                step="any"
                min={0}
                disabled={pending}
                {...form.register(`inputs.${index}.qty`)}
              />
            </FormField>
            <FormField label="Unidad" htmlFor={`mfg-new-input-unit-${index}`}>
              <Input
                id={`mfg-new-input-unit-${index}`}
                disabled={pending}
                {...form.register(`inputs.${index}.unit`)}
              />
            </FormField>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Quitar el material ${index + 1}`}
              disabled={pending || inputs.fields.length === 1}
              onClick={() => inputs.remove(index)}
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
            onClick={() => inputs.append({ zohoItemId: '', qty: 0, unit: '' })}
          >
            <Plus size={14} aria-hidden="true" />
            Agregar material
          </Button>
        </div>

        <label className="mfg-day-toggle">
          <input type="checkbox" disabled={pending} {...form.register('allowSameItem')} />
          La entrada y la salida son el mismo artículo (corte a medida)
        </label>
        {form.formState.errors.allowSameItem ? (
          <p className="form-error">{form.formState.errors.allowSameItem.message}</p>
        ) : null}
      </section>

      <section className="mfg-section">
        <h2 className="mfg-section-title">Cómo y dónde</h2>
        <div className="mfg-grid-3">
          <FormField label="Centro de trabajo" htmlFor="mfg-new-center">
            <Select id="mfg-new-center" disabled={pending} {...form.register('workCenterId')}>
              <option value="">Sin asignar todavía</option>
              {centers.map((center) => (
                <option key={center.id} value={center.id}>
                  {center.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Inicia" htmlFor="mfg-new-start">
            <Input
              id="mfg-new-start"
              type="datetime-local"
              disabled={pending}
              {...form.register('plannedStartAt')}
            />
          </FormField>
          <FormField
            label="Bodega de salida"
            htmlFor="mfg-new-warehouse"
            error={form.formState.errors.outputWarehouseId?.message ?? null}
          >
            <Select
              id="mfg-new-warehouse"
              disabled={pending}
              {...form.register('outputWarehouseId')}
            >
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="mfg-grid-3">
          <FormField label="Prioridad" htmlFor="mfg-new-priority">
            <Select id="mfg-new-priority" disabled={pending} {...form.register('priority')}>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </Select>
          </FormField>
          <FormField label="Se libera a" htmlFor="mfg-new-release">
            <Select id="mfg-new-release" disabled={pending} {...form.register('releaseTarget')}>
              <option value="inventory">Inventario</option>
              <option value="logistics">Logística</option>
            </Select>
          </FormField>
          <FormField
            label="Tolerancia de merma (%)"
            htmlFor="mfg-new-scrap"
            error={form.formState.errors.scrapAllowancePct?.message ?? null}
            help="Vacío = la tolerancia por defecto."
          >
            <Input
              id="mfg-new-scrap"
              type="number"
              step="any"
              min={0}
              max={100}
              disabled={pending}
              {...form.register('scrapAllowancePct')}
            />
          </FormField>
        </div>

        <FormField
          label="Nombre de la operación"
          htmlFor="mfg-new-operation"
          help="Vacío = “Corte/acabado”."
        >
          <Input id="mfg-new-operation" disabled={pending} {...form.register('operationName')} />
        </FormField>

        <label className="mfg-day-toggle">
          <input type="checkbox" disabled={pending} {...form.register('reserveNow')} />
          Apartar el material ahora (si falta, se abre la solicitud a Compras)
        </label>
      </section>

      <div className="mfg-card-actions">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creando…' : 'Crear orden'}
        </Button>
      </div>
    </form>
  );
}
