'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import {
  Alert,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  buildTripInput,
  formatWindow,
  type DispatchDelivery,
  type DispatchDriver,
  type DispatchVehicle,
} from '@/modules/areas/logistica/logistics-view-model';

export interface BuildTripDialogProps {
  date: string;
  vehicles: DispatchVehicle[];
  drivers: DispatchDriver[];
  /** Deliveries that can travel on a trip of the own fleet. */
  candidates: DispatchDelivery[];
  preselectedVehicleId?: string | null;
  preselectedDeliveryIds?: string[];
  canManageFleet: boolean;
  online: boolean;
  onClose: () => void;
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Revisa la fecha del viaje'),
  vehicleId: z.string().min(1, 'Elige la unidad'),
  driverId: z.string().min(1, 'Elige al chofer'),
  optimize: z.boolean(),
  overrideCapacity: z.boolean(),
  notes: z.string().trim().max(1000),
});

type Values = z.infer<typeof schema>;

/**
 * Builds a trip of the own fleet (plan 6.3): unit, driver, day and the
 * deliveries it carries. The route rules order the stops and check the capacity
 * in the engine; going over it needs `logistics.manage_fleet`, so the override
 * is only offered to whoever holds it.
 */
export function BuildTripDialog({
  date,
  vehicles,
  drivers,
  candidates,
  preselectedVehicleId,
  preselectedDeliveryIds = [],
  canManageFleet,
  online,
  onClose,
  onSubmit,
}: BuildTripDialogProps) {
  const [selected, setSelected] = useState<string[]>(
    preselectedDeliveryIds.filter((id) => candidates.some((delivery) => delivery.id === id))
  );
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      date,
      vehicleId: preselectedVehicleId ?? '',
      driverId: '',
      optimize: true,
      overrideCapacity: false,
      notes: '',
    },
  });

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  }

  async function submit(values: Values) {
    setError(null);
    if (selected.length === 0) {
      setError('Elige al menos una entrega para el viaje.');
      return;
    }
    const done = await onSubmit(
      buildTripInput({
        date: values.date,
        vehicleId: values.vehicleId,
        driverId: values.driverId,
        deliveryOrderIds: selected,
        optimize: values.optimize,
        overrideCapacity: canManageFleet ? values.overrideCapacity : false,
        notes: values.notes,
      }),
      'Viaje armado'
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !isSubmitting ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Armar viaje</DialogTitle>
          <DialogDescription>
            Sólo las entregas con flotilla propia viajan en un viaje. El orden de las paradas lo
            calcula UNIK y puedes cambiarlo después.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {!online ? (
            <Alert variant="info">
              Sin conexión: el viaje se guarda en este dispositivo y se envía al volver la señal.
            </Alert>
          ) : null}

          <div className="fleet-form">
            <FormField label="Fecha" htmlFor="trip-date" error={errors.date?.message ?? null}>
              <Input id="trip-date" type="date" {...register('date')} />
            </FormField>
            <FormField
              label="Unidad"
              htmlFor="trip-vehicle"
              error={errors.vehicleId?.message ?? null}
            >
              <Select id="trip-vehicle" {...register('vehicleId')}>
                <option value="">Selecciona una unidad</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id} disabled={!vehicle.available}>
                    {vehicle.label} · {vehicle.plate}
                    {vehicle.available ? '' : ' (no disponible)'}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Chofer"
              htmlFor="trip-driver"
              error={errors.driverId?.message ?? null}
            >
              <Select id="trip-driver" {...register('driverId')}>
                <option value="">Selecciona un chofer</option>
                {drivers.map((driver) => (
                  <option key={driver.id} value={driver.id} disabled={!driver.available}>
                    {driver.name}
                    {driver.available ? '' : ' (no disponible)'}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Notas (opcional)" htmlFor="trip-notes">
              <Textarea id="trip-notes" rows={2} maxLength={1000} {...register('notes')} />
            </FormField>
          </div>

          <fieldset className="grid gap-2">
            <legend className="form-label">
              Entregas del viaje ({selected.length} de {candidates.length})
            </legend>
            {candidates.length === 0 ? (
              <p className="dispatch-column-hint">
                No hay entregas con flotilla propia esperando viaje en este día.
              </p>
            ) : (
              <div className="dispatch-column-body" style={{ maxHeight: '16rem' }}>
                {candidates.map((delivery) => (
                  <Checkbox
                    key={delivery.id}
                    label={`${delivery.customerName ?? delivery.caseNumber ?? 'Entrega'} · ${delivery.address.city ?? 'Sin ciudad'}`}
                    description={
                      formatWindow(delivery.windowStart, delivery.windowEnd) ??
                      `${delivery.lines.length} línea(s) · ${delivery.statusLabel}`
                    }
                    checked={selected.includes(delivery.id)}
                    onChange={() => toggle(delivery.id)}
                  />
                ))}
              </div>
            )}
          </fieldset>

          <Checkbox
            label="Ordenar las paradas automáticamente"
            description="Vecino más cercano respetando las ventanas de entrega."
            {...register('optimize')}
          />
          {canManageFleet ? (
            <Checkbox
              label="Permitir cargar sobre la capacidad"
              description="Sólo si sabes que la unidad lo aguanta: queda registrado en el evento del viaje."
              {...register('overrideCapacity')}
            />
          ) : null}

          {error ? <Alert variant="error">{error}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit(submit)}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Armando…' : 'Armar viaje'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
