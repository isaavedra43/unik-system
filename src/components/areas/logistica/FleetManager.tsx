'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Pencil, Plus, Truck, User } from 'lucide-react';
import { toast } from 'sonner';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { Drawer } from '@/components/ui/composite';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
} from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  createDriverInput,
  createVehicleInput,
  formatDayLabel,
  updateDriverInput,
  updateVehicleInput,
  type DispatchDriver,
  type DispatchVehicle,
  type FleetOverviewData,
} from '@/modules/areas/logistica/logistics-view-model';
import '@/styles/operations/logistica.css';

export interface FleetManagerProps {
  user: { id: string; name: string };
  data: FleetOverviewData;
  /** Active people who can be linked to a driver (only loaded for fleet managers). */
  linkableUsers: Array<{ id: string; name: string }>;
}

const vehicleSchema = z.object({
  code: z.string().trim().min(1, 'Indica el código').max(40),
  plate: z.string().trim().min(1, 'Indica las placas').max(20),
  label: z.string().trim().min(1, 'Indica el nombre de la unidad').max(120),
  capacityKg: z.string(),
  capacityM2: z.string(),
  capacityPieces: z.string(),
  maintenanceUntil: z.string(),
  active: z.boolean(),
});

const driverSchema = z.object({
  name: z.string().trim().min(1, 'Indica el nombre').max(120),
  phone: z.string().trim().max(40),
  licenseNumber: z.string().trim().max(60),
  userId: z.string(),
  active: z.boolean(),
});

type VehicleValues = z.infer<typeof vehicleSchema>;
type DriverValues = z.infer<typeof driverSchema>;

/** Empty text → null; a number written by a person → number, never NaN. */
function optionalNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Fleet of the area (plan 7.1 `/app/areas/logistica/flota`): units and drivers
 * with their availability for today, and the forms that create or edit them.
 *
 * Every write is a `fleet.*` command: the engine refuses to deactivate a unit
 * or a driver with active trips and keeps the codes unique, so this screen only
 * collects the data and reports what the engine answered.
 */
export function FleetManager({ user, data, linkableUsers }: FleetManagerProps) {
  const router = useRouter();
  const { submit, online } = useOfflineCommandQueue(user.id);
  const [vehicleDrawer, setVehicleDrawer] = useState<{ vehicle: DispatchVehicle | null } | null>(
    null
  );
  const [driverDrawer, setDriverDrawer] = useState<{ driver: DispatchDriver | null } | null>(null);
  const canManage = data.permissions.canManageFleet;

  const runCommand = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      const outcome = await submit<Record<string, unknown>>(input);
      const feedback = describeSubmitOutcome(outcome, successMessage);
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      if (feedback.refresh) router.refresh();
      return feedback.kind === 'success' || feedback.kind === 'queued';
    },
    [submit, router]
  );

  const tripsOf = (key: 'vehicleId' | 'driverId', id: string) =>
    data.trips.filter((trip) => trip[key] === id);

  return (
    <div className="fleet-page">
      {!canManage ? (
        <Alert variant="info">
          Puedes consultar la flotilla. Para dar de alta o editar unidades y choferes necesitas el
          permiso «Gestionar flotilla».
        </Alert>
      ) : null}
      {!online ? (
        <Alert variant="warning">
          Sin conexión: los cambios se guardan en este dispositivo y se envían al reconectar.
        </Alert>
      ) : null}

      <section className="fleet-section" aria-labelledby="fleet-vehicles">
        <header className="fleet-section-header">
          <h3 id="fleet-vehicles" className="area-drawer-section-title">
            Unidades ({data.vehicles.length})
          </h3>
          {canManage ? (
            <Button variant="primary" size="sm" onClick={() => setVehicleDrawer({ vehicle: null })}>
              <Plus size={14} aria-hidden="true" />
              Agregar unidad
            </Button>
          ) : null}
        </header>
        {data.vehicles.length === 0 ? (
          <p className="dispatch-column-hint">
            No hay unidades registradas. Agrega la primera para poder armar viajes.
          </p>
        ) : (
          <div className="fleet-grid">
            {data.vehicles.map((vehicle) => {
              const trips = tripsOf('vehicleId', vehicle.id);
              return (
                <article key={vehicle.id} className="fleet-card">
                  <div className="fleet-card-head">
                    <div className="fleet-card-title">
                      <strong>
                        <Truck size={14} aria-hidden="true" /> {vehicle.label}
                      </strong>
                      <span className="fleet-card-meta">
                        {vehicle.code} · {vehicle.plate}
                      </span>
                    </div>
                    <Badge
                      variant={vehicle.available ? 'success' : vehicle.active ? 'warning' : 'weak'}
                    >
                      {vehicle.available ? 'Disponible' : vehicle.active ? 'Ocupada' : 'Inactiva'}
                    </Badge>
                  </div>
                  <p className="fleet-card-meta">
                    {[
                      vehicle.capacityKg !== null ? `${vehicle.capacityKg} kg` : null,
                      vehicle.capacityM2 !== null ? `${vehicle.capacityM2} m²` : null,
                      vehicle.capacityPieces !== null ? `${vehicle.capacityPieces} piezas` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Sin capacidad declarada'}
                  </p>
                  {vehicle.maintenanceUntil ? (
                    <p className="fleet-card-meta">
                      En mantenimiento hasta {formatDayLabel(vehicle.maintenanceUntil)}
                    </p>
                  ) : null}
                  {trips.length > 0 ? (
                    <p className="fleet-card-meta">
                      Viajes activos: {trips.map((trip) => trip.number).join(', ')}
                    </p>
                  ) : null}
                  {canManage ? (
                    <div className="dispatch-card-actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setVehicleDrawer({ vehicle })}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        Editar
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="fleet-section" aria-labelledby="fleet-drivers">
        <header className="fleet-section-header">
          <h3 id="fleet-drivers" className="area-drawer-section-title">
            Choferes ({data.drivers.length})
          </h3>
          {canManage ? (
            <Button variant="primary" size="sm" onClick={() => setDriverDrawer({ driver: null })}>
              <Plus size={14} aria-hidden="true" />
              Agregar chofer
            </Button>
          ) : null}
        </header>
        {data.drivers.length === 0 ? (
          <p className="dispatch-column-hint">
            No hay choferes registrados. Ligar a cada chofer con su usuario le abre la vista de
            chofer en el teléfono.
          </p>
        ) : (
          <div className="fleet-grid">
            {data.drivers.map((driver) => {
              const trips = tripsOf('driverId', driver.id);
              return (
                <article key={driver.id} className="fleet-card">
                  <div className="fleet-card-head">
                    <div className="fleet-card-title">
                      <strong>
                        <User size={14} aria-hidden="true" /> {driver.name}
                      </strong>
                      <span className="fleet-card-meta">
                        {driver.phone ?? 'Sin teléfono'}
                        {driver.licenseNumber ? ` · Licencia ${driver.licenseNumber}` : ''}
                      </span>
                    </div>
                    <Badge
                      variant={driver.available ? 'success' : driver.active ? 'warning' : 'weak'}
                    >
                      {driver.available ? 'Disponible' : driver.active ? 'Ocupado' : 'Inactivo'}
                    </Badge>
                  </div>
                  <p className="fleet-card-meta">
                    {driver.userId
                      ? 'Ligado a un usuario: puede usar la vista de chofer'
                      : 'Sin usuario ligado: no puede usar la vista de chofer'}
                  </p>
                  {trips.length > 0 ? (
                    <p className="fleet-card-meta">
                      Viajes activos: {trips.map((trip) => trip.number).join(', ')}
                    </p>
                  ) : null}
                  {canManage ? (
                    <div className="dispatch-card-actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDriverDrawer({ driver })}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        Editar
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {vehicleDrawer ? (
        <VehicleDrawer
          vehicle={vehicleDrawer.vehicle}
          onClose={() => setVehicleDrawer(null)}
          onSubmit={runCommand}
        />
      ) : null}

      {driverDrawer ? (
        <DriverDrawer
          driver={driverDrawer.driver}
          users={linkableUsers}
          onClose={() => setDriverDrawer(null)}
          onSubmit={runCommand}
        />
      ) : null}
    </div>
  );
}

type RunCommand = (
  input: OfflineCommandInput<Record<string, unknown>>,
  successMessage: string
) => Promise<boolean>;

function VehicleDrawer({
  vehicle,
  onClose,
  onSubmit,
}: {
  vehicle: DispatchVehicle | null;
  onClose: () => void;
  onSubmit: RunCommand;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<VehicleValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: {
      code: vehicle?.code ?? '',
      plate: vehicle?.plate ?? '',
      label: vehicle?.label ?? '',
      capacityKg: vehicle?.capacityKg !== null && vehicle ? String(vehicle.capacityKg) : '',
      capacityM2: vehicle?.capacityM2 !== null && vehicle ? String(vehicle.capacityM2) : '',
      capacityPieces:
        vehicle?.capacityPieces !== null && vehicle ? String(vehicle.capacityPieces) : '',
      maintenanceUntil: vehicle?.maintenanceUntil ?? '',
      active: vehicle?.active ?? true,
    },
  });

  async function save(values: VehicleValues) {
    const payload = {
      code: values.code,
      plate: values.plate,
      label: values.label,
      capacityKg: optionalNumber(values.capacityKg),
      capacityM2: optionalNumber(values.capacityM2),
      capacityPieces: optionalNumber(values.capacityPieces),
      maintenanceUntil: values.maintenanceUntil || null,
      active: values.active,
    };
    const done = await onSubmit(
      vehicle ? updateVehicleInput(vehicle.id, payload) : createVehicleInput(payload),
      vehicle ? 'Unidad actualizada' : 'Unidad registrada'
    );
    if (done) onClose();
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={vehicle ? `Editar ${vehicle.label}` : 'Agregar unidad'}
      subtitle="Las capacidades se usan para avisar cuando un viaje se pasa de carga."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit(save)} disabled={isSubmitting}>
            {isSubmitting ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <div className="fleet-form">
        <FormField label="Código" htmlFor="vehicle-code" error={errors.code?.message ?? null}>
          <Input id="vehicle-code" {...register('code')} />
        </FormField>
        <FormField label="Placas" htmlFor="vehicle-plate" error={errors.plate?.message ?? null}>
          <Input id="vehicle-plate" {...register('plate')} />
        </FormField>
        <FormField
          label="Nombre de la unidad"
          htmlFor="vehicle-label"
          error={errors.label?.message ?? null}
        >
          <Input id="vehicle-label" {...register('label')} />
        </FormField>
        <FormField label="Capacidad en kg" htmlFor="vehicle-kg">
          <Input id="vehicle-kg" inputMode="decimal" {...register('capacityKg')} />
        </FormField>
        <FormField label="Capacidad en m²" htmlFor="vehicle-m2">
          <Input id="vehicle-m2" inputMode="decimal" {...register('capacityM2')} />
        </FormField>
        <FormField label="Capacidad en piezas" htmlFor="vehicle-pieces">
          <Input id="vehicle-pieces" inputMode="numeric" {...register('capacityPieces')} />
        </FormField>
        <FormField
          label="En mantenimiento hasta"
          htmlFor="vehicle-maintenance"
          help="Déjalo vacío si la unidad está en servicio."
        >
          <Input id="vehicle-maintenance" type="date" {...register('maintenanceUntil')} />
        </FormField>
        <div className="fleet-form-full">
          <Checkbox
            label="Unidad activa"
            description="Una unidad con viajes activos no se puede desactivar."
            {...register('active')}
          />
        </div>
      </div>
    </Drawer>
  );
}

function DriverDrawer({
  driver,
  users,
  onClose,
  onSubmit,
}: {
  driver: DispatchDriver | null;
  users: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSubmit: RunCommand;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<DriverValues>({
    resolver: zodResolver(driverSchema),
    defaultValues: {
      name: driver?.name ?? '',
      phone: driver?.phone ?? '',
      licenseNumber: driver?.licenseNumber ?? '',
      userId: driver?.userId ?? '',
      active: driver?.active ?? true,
    },
  });

  async function save(values: DriverValues) {
    const payload = {
      name: values.name,
      phone: values.phone,
      licenseNumber: values.licenseNumber,
      userId: values.userId || null,
      active: values.active,
    };
    const done = await onSubmit(
      driver ? updateDriverInput(driver.id, payload) : createDriverInput(payload),
      driver ? 'Chofer actualizado' : 'Chofer registrado'
    );
    if (done) onClose();
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={driver ? `Editar ${driver.name}` : 'Agregar chofer'}
      subtitle="Ligar al chofer con su usuario le abre la vista de chofer en el teléfono."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit(save)} disabled={isSubmitting}>
            {isSubmitting ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <div className="fleet-form">
        <FormField label="Nombre" htmlFor="driver-name" error={errors.name?.message ?? null}>
          <Input id="driver-name" {...register('name')} />
        </FormField>
        <FormField label="Teléfono" htmlFor="driver-phone">
          <Input id="driver-phone" inputMode="tel" {...register('phone')} />
        </FormField>
        <FormField label="Licencia" htmlFor="driver-license">
          <Input id="driver-license" {...register('licenseNumber')} />
        </FormField>
        <FormField
          label="Usuario del sistema"
          htmlFor="driver-user"
          help="Sólo un chofer puede estar ligado a cada usuario."
        >
          <Select id="driver-user" {...register('userId')}>
            <option value="">Sin usuario ligado</option>
            {users.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="fleet-form-full">
          <Checkbox
            label="Chofer activo"
            description="Un chofer con viajes activos no se puede desactivar."
            {...register('active')}
          />
        </div>
      </div>
    </Drawer>
  );
}
