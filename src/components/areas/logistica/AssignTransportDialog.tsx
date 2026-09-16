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
import { Alert, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  assignTransportInput,
  shippingModeOptions,
  zohoPill,
  type DispatchDelivery,
  type DispatchDriver,
  type DispatchVehicle,
} from '@/modules/areas/logistica/logistics-view-model';
import { SHIPPING_MODES, isShippingMode } from '@/modules/logistics/types';

export interface AssignTransportDialogProps {
  delivery: DispatchDelivery;
  vehicles: DispatchVehicle[];
  drivers: DispatchDriver[];
  /** Day of the board: the default shipment date. */
  date: string;
  canWriteZoho: boolean;
  online: boolean;
  onClose: () => void;
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

const schema = z
  .object({
    mode: z.enum(SHIPPING_MODES),
    carrier: z.string().trim().min(1, 'Indica el transportista').max(100),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Revisa la fecha de envío'),
    trackingNumber: z.string().trim().max(100),
    vehicleId: z.string(),
    driverId: z.string(),
  })
  .refine(
    (values) =>
      values.mode !== 'own_fleet' || values.vehicleId.length > 0 || values.driverId.length === 0,
    {
      path: ['vehicleId'],
      message: 'Con chofer asignado indica también la unidad',
    }
  );

type Values = z.infer<typeof schema>;

/**
 * Assigns transport to a delivery (plan 4.2). It never calls Zoho: the command
 * stores what must be written and the outbox mirrors it, so the dialog closes
 * as soon as the engine accepts it and the board shows "Esperando a Zoho".
 *
 * It also decides HOW it ships (plan §4 `mode`): with own fleet the engine
 * demands vehicle AND driver, so this form asks for both and only offers the
 * ones available that day; with a carrier (a courier or an external haulier)
 * neither is sent and the tracking number is what travels. The mode can only be
 * switched while the delivery is not loaded on a trip of the own fleet.
 */
export function AssignTransportDialog({
  delivery,
  vehicles,
  drivers,
  date,
  canWriteZoho,
  online,
  onClose,
  onSubmit,
}: AssignTransportDialogProps) {
  const [error, setError] = useState<string | null>(null);
  // Only a shipping delivery (own fleet / carrier) writes a shipment order in
  // Zoho; a pickup or a direct supplier delivery cannot change its mode here.
  const switchable = isShippingMode(delivery.mode);
  const pill = zohoPill(delivery);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      mode: isShippingMode(delivery.mode) ? delivery.mode : 'own_fleet',
      carrier: delivery.carrier ?? '',
      date: delivery.plannedDate ? delivery.plannedDate.slice(0, 10) : date,
      trackingNumber: delivery.trackingNumber ?? '',
      vehicleId: delivery.vehicleId ?? '',
      driverId: delivery.driverId ?? '',
    },
  });
  const mode = watch('mode');
  const ownFleet = mode === 'own_fleet';
  const onTrip = Boolean(delivery.tripId);

  async function submit(values: Values) {
    setError(null);
    if (values.mode === 'own_fleet' && (!values.vehicleId || !values.driverId)) {
      setError('Con flotilla propia hay que indicar la unidad y el chofer.');
      return;
    }
    if (values.mode !== delivery.mode && onTrip) {
      const trip = delivery.tripNumber ? `el viaje ${delivery.tripNumber}` : 'un viaje';
      setError(`La entrega va en ${trip}. Quítala del viaje antes de cambiar cómo se envía.`);
      return;
    }
    const done = await onSubmit(
      assignTransportInput(delivery, {
        carrier: values.carrier,
        date: values.date,
        trackingNumber: values.trackingNumber,
        vehicleId: values.vehicleId || null,
        driverId: values.driverId || null,
        ...(switchable ? { mode: values.mode } : {}),
      }),
      'Transporte asignado · escribiendo en Zoho'
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !isSubmitting ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Asignar transporte</DialogTitle>
          <DialogDescription>
            {delivery.customerName ?? delivery.caseNumber ?? 'Entrega'} ·{' '}
            {delivery.salesOrderNumber ?? delivery.caseNumber ?? ''}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {!canWriteZoho ? (
            <Alert variant="warning">
              No tienes permiso para escribir embarques en Zoho, así que esta asignación se
              rechazará. Pídele a Administración el permiso «Escribir embarques en Zoho».
            </Alert>
          ) : null}
          {!online ? (
            <Alert variant="info">
              Sin conexión: la asignación se guarda en este dispositivo y se envía sola al volver.
            </Alert>
          ) : null}
          {pill && pill.actionable ? <Alert variant="warning">{pill.detail}</Alert> : null}
          {delivery.zohoDifferences.length > 0 ? (
            <Alert variant="warning">
              Zoho tiene otros valores:{' '}
              {delivery.zohoDifferences
                .map((row) => `${row.label} «${row.actual ?? 'vacío'}»`)
                .join(', ')}
              . Si vuelves a escribir, se reemplazan con los de abajo.
            </Alert>
          ) : null}

          {switchable ? (
            <FormField
              label="Cómo se envía"
              htmlFor="assign-mode"
              help={
                onTrip
                  ? `Va en ${delivery.tripNumber ? `el viaje ${delivery.tripNumber}` : 'un viaje'}: para enviarla por paquetería quítala del viaje primero.`
                  : 'Flotilla propia viaja con unidad y chofer nuestros; paquetería viaja con su número de guía.'
              }
            >
              <Select id="assign-mode" disabled={onTrip} {...register('mode')}>
                {shippingModeOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          <FormField
            label="Transportista"
            htmlFor="assign-carrier"
            help={
              ownFleet
                ? 'Se escribe en Zoho como método de entrega; con flotilla propia suele ser el nombre de la unidad.'
                : 'Nombre de la paquetería o del transportista.'
            }
            error={errors.carrier?.message ?? null}
          >
            <Input id="assign-carrier" autoFocus {...register('carrier')} />
          </FormField>

          <FormField
            label="Fecha de envío"
            htmlFor="assign-date"
            error={errors.date?.message ?? null}
          >
            <Input id="assign-date" type="date" {...register('date')} />
          </FormField>

          <FormField
            label="Número de guía (opcional)"
            htmlFor="assign-tracking"
            help="Si lo dejas vacío, UNIK no compara la guía con la de Zoho."
          >
            <Input id="assign-tracking" {...register('trackingNumber')} />
          </FormField>

          {ownFleet ? (
            <>
              <FormField
                label="Unidad"
                htmlFor="assign-vehicle"
                error={errors.vehicleId?.message ?? null}
              >
                <Select id="assign-vehicle" {...register('vehicleId')}>
                  <option value="">Selecciona una unidad</option>
                  {vehicles.map((vehicle) => (
                    <option key={vehicle.id} value={vehicle.id} disabled={!vehicle.available}>
                      {vehicle.label} · {vehicle.plate}
                      {vehicle.available ? '' : ' (no disponible)'}
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField label="Chofer" htmlFor="assign-driver">
                <Select id="assign-driver" {...register('driverId')}>
                  <option value="">Selecciona un chofer</option>
                  {drivers.map((driver) => (
                    <option key={driver.id} value={driver.id} disabled={!driver.available}>
                      {driver.name}
                      {driver.available ? '' : ' (no disponible)'}
                    </option>
                  ))}
                </Select>
              </FormField>
            </>
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
            disabled={isSubmitting || !canWriteZoho}
          >
            {isSubmitting ? 'Enviando…' : 'Asignar y escribir en Zoho'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
