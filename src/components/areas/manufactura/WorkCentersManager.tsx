'use client';

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { createWorkCenterAction, updateWorkCenterAction } from '@/app/app/manufacturing/actions';
import { Alert, Badge, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { WorkCenterRow } from '@/modules/manufacturing/manufacturing-queries';
import { CAPACITY_UNITS, CAPACITY_UNIT_LABELS } from '@/modules/manufacturing/manufacturing-types';
import { useOrderAction } from './use-order-action';

export interface WorkCentersManagerProps {
  centers: WorkCenterRow[];
  warehouses: Array<{ id: string; name: string }>;
  /** `manufacturing.manage_boms`; without it the page is read only. */
  canManage: boolean;
}

/**
 * Centros de trabajo y sus turnos (plan 6.2). The shifts are what the scheduler
 * plans against: without them a centre has no capacity windows, so the board
 * cannot show its load and `planSlot` has nowhere to put an operation — the page
 * says so out loud.
 *
 * Hours are the plant's local time and the days are ISO weekdays (1 = lunes).
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const schema = z
  .object({
    key: z.string().trim().max(60),
    name: z.string().trim().min(1, 'Ponle nombre al centro').max(120),
    capacityPerShift: z.coerce.number().finite().positive('La capacidad debe ser mayor que cero'),
    capacityUnit: z.enum(CAPACITY_UNITS),
    warehouseId: z.string().trim().max(120),
    costPerHour: z.string().trim().max(20),
    status: z.enum(['active', 'inactive']),
    shifts: z.array(
      z.object({
        name: z.string().trim().min(1, 'Nombre del turno').max(60),
        start: z.string().trim().regex(HHMM, 'Hora inválida (HH:mm)'),
        end: z.string().trim().regex(HHMM, 'Hora inválida (HH:mm)'),
        days: z.array(z.string()).min(1, 'Elige al menos un día'),
      })
    ),
  })
  .superRefine((value, ctx) => {
    value.shifts.forEach((shift, index) => {
      if (shift.start === shift.end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['shifts', index, 'end'],
          message: 'El turno no puede empezar y terminar a la misma hora',
        });
      }
    });
    if (value.costPerHour.trim() && !Number.isFinite(Number(value.costPerHour))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['costPerHour'],
        message: 'El costo por hora debe ser un número',
      });
    }
  });

type FormValues = z.output<typeof schema>;

const DAYS: Array<{ value: string; label: string }> = [
  { value: '1', label: 'Lun' },
  { value: '2', label: 'Mar' },
  { value: '3', label: 'Mié' },
  { value: '4', label: 'Jue' },
  { value: '5', label: 'Vie' },
  { value: '6', label: 'Sáb' },
  { value: '7', label: 'Dom' },
];

const EMPTY: FormValues = {
  key: '',
  name: '',
  capacityPerShift: 0,
  capacityUnit: 'minutes',
  warehouseId: '',
  costPerHour: '',
  status: 'active',
  shifts: [],
};

export function WorkCentersManager({ centers, warehouses, canManage }: WorkCentersManagerProps) {
  const { runAction, pending, error } = useOrderAction();
  const [editing, setEditing] = useState<WorkCenterRow | null>(null);
  const [open, setOpen] = useState(false);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  const shifts = useFieldArray({ control: form.control, name: 'shifts' });

  function startCreate() {
    setEditing(null);
    form.reset(EMPTY);
    setOpen(true);
  }

  function startEdit(center: WorkCenterRow) {
    setEditing(center);
    form.reset({
      key: center.key,
      name: center.name,
      capacityPerShift: Number(center.capacityPerShift) || 0,
      capacityUnit: center.capacityUnit as FormValues['capacityUnit'],
      warehouseId: center.warehouseId ?? '',
      costPerHour: center.costPerHour ?? '',
      status: center.status === 'inactive' ? 'inactive' : 'active',
      shifts: center.shifts.map((shift) => ({
        name: shift.name,
        start: shift.start,
        end: shift.end,
        days: shift.days.map(String),
      })),
    });
    setOpen(true);
  }

  const submit = form.handleSubmit(async (values) => {
    const shiftsPayload = values.shifts.map((shift) => ({
      name: shift.name,
      start: shift.start,
      end: shift.end,
      days: shift.days.map(Number),
    }));
    const ok = await runAction(() =>
      editing
        ? updateWorkCenterAction({
            workCenterId: editing.id,
            name: values.name,
            capacityPerShift: values.capacityPerShift,
            capacityUnit: values.capacityUnit,
            warehouseId: values.warehouseId || null,
            costPerHour: values.costPerHour.trim() ? Number(values.costPerHour) : null,
            status: values.status,
            shifts: shiftsPayload,
          })
        : createWorkCenterAction({
            key: values.key.trim() || values.name,
            name: values.name,
            capacityPerShift: values.capacityPerShift,
            capacityUnit: values.capacityUnit,
            warehouseId: values.warehouseId || null,
            costPerHour: values.costPerHour.trim() ? Number(values.costPerHour) : null,
            shifts: shiftsPayload,
          })
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
          Centros de trabajo
          {canManage ? (
            <Button variant="primary" size="sm" disabled={pending} onClick={startCreate}>
              <Plus size={14} aria-hidden="true" />
              Nuevo centro
            </Button>
          ) : null}
        </h2>

        {centers.length === 0 ? (
          <div className="mfg-empty">
            <strong>Todavía no hay centros de trabajo</strong>
            <p>
              Un centro define dónde se produce y cuánta capacidad tiene por turno. Sin centros, las
              órdenes no se pueden programar contra capacidad real.
            </p>
          </div>
        ) : (
          <div className="mfg-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Centro</th>
                  <th scope="col">Capacidad por turno</th>
                  <th scope="col">Turnos</th>
                  <th scope="col">Bodega</th>
                  <th scope="col">Estado</th>
                  {canManage ? <th scope="col">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {centers.map((center) => (
                  <tr key={center.id}>
                    <td>
                      {center.name}
                      <div className="area-row-sub">{center.key}</div>
                    </td>
                    <td>
                      {center.capacityPerShift} {center.capacityUnitLabel}
                    </td>
                    <td>
                      {center.shifts.length === 0 ? (
                        <span className="area-row-due-warning">Sin turnos</span>
                      ) : (
                        center.shifts.map((shift) => shift.name).join(', ')
                      )}
                    </td>
                    <td>{center.warehouseName ?? '—'}</td>
                    <td>
                      <Badge variant={center.status === 'active' ? 'success' : 'weak'}>
                        {center.statusLabel}
                      </Badge>
                    </td>
                    {canManage ? (
                      <td>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() => startEdit(center)}
                        >
                          Editar
                        </Button>
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
            {editing ? `Editar ${editing.name}` : 'Nuevo centro de trabajo'}
          </h2>

          <div className="mfg-grid-3">
            {!editing ? (
              <FormField
                label="Clave"
                htmlFor="mfg-center-key"
                help="Identificador corto (vacío = se genera del nombre)."
              >
                <Input id="mfg-center-key" disabled={pending} {...form.register('key')} />
              </FormField>
            ) : null}
            <FormField
              label="Nombre"
              htmlFor="mfg-center-name"
              error={form.formState.errors.name?.message ?? null}
            >
              <Input id="mfg-center-name" disabled={pending} {...form.register('name')} />
            </FormField>
            <FormField
              label="Capacidad por turno"
              htmlFor="mfg-center-capacity"
              error={form.formState.errors.capacityPerShift?.message ?? null}
            >
              <Input
                id="mfg-center-capacity"
                type="number"
                step="any"
                min={0}
                disabled={pending}
                {...form.register('capacityPerShift')}
              />
            </FormField>
          </div>

          <div className="mfg-grid-3">
            <FormField
              label="Unidad de capacidad"
              htmlFor="mfg-center-unit"
              help="Minutos mide tiempo; m² y piezas miden la cantidad de la orden."
            >
              <Select id="mfg-center-unit" disabled={pending} {...form.register('capacityUnit')}>
                {CAPACITY_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {CAPACITY_UNIT_LABELS[unit]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Bodega" htmlFor="mfg-center-warehouse">
              <Select
                id="mfg-center-warehouse"
                disabled={pending}
                {...form.register('warehouseId')}
              >
                <option value="">Sin bodega</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Costo por hora"
              htmlFor="mfg-center-cost"
              error={form.formState.errors.costPerHour?.message ?? null}
            >
              <Input
                id="mfg-center-cost"
                type="number"
                step="any"
                min={0}
                disabled={pending}
                {...form.register('costPerHour')}
              />
            </FormField>
          </div>

          {editing ? (
            <FormField label="Estado" htmlFor="mfg-center-status">
              <Select id="mfg-center-status" disabled={pending} {...form.register('status')}>
                <option value="active">Activo</option>
                <option value="inactive">Inactivo</option>
              </Select>
            </FormField>
          ) : null}

          <h3 className="mfg-section-title">Turnos</h3>
          <p className="mfg-section-hint">
            Horario local de la planta. Un turno que termina antes de empezar cruza la medianoche.
            Los turnos de un centro no se pueden encimar.
          </p>

          {shifts.fields.map((field, index) => (
            <div key={field.id} className="mfg-shift-row">
              <FormField
                label="Turno"
                htmlFor={`mfg-shift-name-${index}`}
                error={form.formState.errors.shifts?.[index]?.name?.message ?? null}
              >
                <Input
                  id={`mfg-shift-name-${index}`}
                  disabled={pending}
                  {...form.register(`shifts.${index}.name`)}
                />
              </FormField>
              <FormField
                label="Inicia"
                htmlFor={`mfg-shift-start-${index}`}
                error={form.formState.errors.shifts?.[index]?.start?.message ?? null}
              >
                <Input
                  id={`mfg-shift-start-${index}`}
                  type="time"
                  disabled={pending}
                  {...form.register(`shifts.${index}.start`)}
                />
              </FormField>
              <FormField
                label="Termina"
                htmlFor={`mfg-shift-end-${index}`}
                error={form.formState.errors.shifts?.[index]?.end?.message ?? null}
              >
                <Input
                  id={`mfg-shift-end-${index}`}
                  type="time"
                  disabled={pending}
                  {...form.register(`shifts.${index}.end`)}
                />
              </FormField>
              <fieldset className="mfg-days">
                <legend className="mfg-section-hint">Días</legend>
                {DAYS.map((day) => (
                  <label key={day.value} className="mfg-day-toggle">
                    <input
                      type="checkbox"
                      value={day.value}
                      disabled={pending}
                      {...form.register(`shifts.${index}.days`)}
                    />
                    {day.label}
                  </label>
                ))}
                {form.formState.errors.shifts?.[index]?.days ? (
                  <p className="form-error">{form.formState.errors.shifts[index]?.days?.message}</p>
                ) : null}
              </fieldset>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Quitar el turno ${index + 1}`}
                disabled={pending}
                onClick={() => shifts.remove(index)}
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
              onClick={() =>
                shifts.append({
                  name: '',
                  start: '08:00',
                  end: '16:00',
                  days: ['1', '2', '3', '4', '5'],
                })
              }
            >
              <Plus size={14} aria-hidden="true" />
              Agregar turno
            </Button>
          </div>

          <div className="mfg-card-actions">
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear centro'}
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
