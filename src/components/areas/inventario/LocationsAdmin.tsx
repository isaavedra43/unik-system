'use client';

import '@/styles/operations/inventario.css';
import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Warehouse } from 'lucide-react';
import {
  EMPTY_FORM_STATE,
  createLocationAction,
  createWarehouseAction,
  updateLocationAction,
  updateWarehouseAction,
} from '@/app/app/areas/inventario/actions';
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
import { LOCATION_KINDS, LOCATION_KIND_LABELS } from '@/modules/inventory/inventory-types';
import type { LocationDTO, WarehouseDTO } from '@/modules/inventory/inventory-dto';
import { LabelSheet, type LabelSheetItem } from './LabelSheet';
import { INVENTORY_SPACES, inventoryHref, parseLocationCode } from './inventario-model';

/**
 * Bodegas, ubicaciones y etiquetas (plan 7.6 "ubicaciones"). Every change is a
 * command of the inventory module (`warehouse.create|update`,
 * `location.create|update`) executed by a server action, so the rules that
 * protect stock — a location with existencias no se desactiva, GENERAL y SCRAP
 * no se tocan — are applied by the engine and not by this screen.
 */

export interface WarehouseWithLocationsView extends WarehouseDTO {
  locations: LocationDTO[];
}

export interface LocationsAdminProps {
  warehouses: WarehouseWithLocationsView[];
  selectedWarehouseId: string | null;
  labels: LabelSheetItem[];
  labelKind: 'location' | 'container';
  /** The person holds `inventory.manage`. */
  canManage: boolean;
}

function useRefreshOnSuccess(success: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (success) router.refresh();
  }, [success, router]);
}

function CreateWarehouseForm() {
  const [state, action, pending] = useActionState(createWarehouseAction, EMPTY_FORM_STATE);
  useRefreshOnSuccess(state.success);
  return (
    <form action={action} className="inv-card">
      <p className="inv-card-title">Nueva bodega</p>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success && state.message ? <Alert variant="success">{state.message}</Alert> : null}
      <div className="inv-form-grid">
        <FormField label="Nombre" htmlFor="inv-warehouse-name">
          <Input id="inv-warehouse-name" name="name" required maxLength={120} />
        </FormField>
        <FormField
          label="Clave (opcional)"
          htmlFor="inv-warehouse-key"
          help="Minúsculas, números y guiones. Si la dejas vacía la generamos del nombre."
        >
          <Input id="inv-warehouse-key" name="key" maxLength={40} autoComplete="off" />
        </FormField>
      </div>
      <div className="inv-form-actions">
        <Button type="submit" size="sm" isLoading={pending}>
          <Warehouse size={14} aria-hidden="true" />
          Crear bodega
        </Button>
        <span className="inv-card-hint">Se crea con su ubicación GENERAL.</span>
      </div>
    </form>
  );
}

function CreateLocationForm({ warehouseId }: { warehouseId: string }) {
  const [state, action, pending] = useActionState(createLocationAction, EMPTY_FORM_STATE);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  useRefreshOnSuccess(state.success);

  return (
    <form
      action={action}
      className="inv-card"
      onSubmit={(event) => {
        const checked = parseLocationCode(code);
        if (!checked.ok) {
          event.preventDefault();
          setCodeError(checked.error);
          return;
        }
        setCodeError(null);
      }}
    >
      <p className="inv-card-title">Nueva ubicación</p>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success && state.message ? <Alert variant="success">{state.message}</Alert> : null}
      <input type="hidden" name="warehouseId" value={warehouseId} />
      <div className="inv-form-grid">
        <FormField
          label="Código"
          htmlFor="inv-location-code"
          error={codeError}
          help="Se guarda en mayúsculas: A-01, RACK-3, PATIO."
        >
          <Input
            id="inv-location-code"
            name="code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            maxLength={40}
            autoComplete="off"
            error={codeError}
          />
        </FormField>
        <FormField label="Nombre (opcional)" htmlFor="inv-location-label">
          <Input id="inv-location-label" name="label" maxLength={120} />
        </FormField>
        <FormField label="Tipo" htmlFor="inv-location-kind">
          <Select id="inv-location-kind" name="kind" defaultValue="rack">
            {LOCATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {LOCATION_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <div className="inv-form-actions">
        <Button type="submit" size="sm" isLoading={pending}>
          <Plus size={14} aria-hidden="true" />
          Crear ubicación
        </Button>
      </div>
    </form>
  );
}

function EditLocationDrawer({ location, onClose }: { location: LocationDTO; onClose: () => void }) {
  const [state, action, pending] = useActionState(updateLocationAction, EMPTY_FORM_STATE);
  const [active, setActive] = useState(location.active);
  useRefreshOnSuccess(state.success);

  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Ubicación ${location.code}`}
      subtitle={location.kindLabel}
    >
      <form action={action} className="inv-form">
        {state.error ? <Alert variant="error">{state.error}</Alert> : null}
        <input type="hidden" name="locationId" value={location.id} />
        <input type="hidden" name="active" value={String(active)} />
        <FormField label="Nombre" htmlFor="inv-edit-location-label">
          <Input
            id="inv-edit-location-label"
            name="label"
            defaultValue={location.label ?? ''}
            maxLength={120}
          />
        </FormField>
        <FormField label="Tipo" htmlFor="inv-edit-location-kind">
          <Select id="inv-edit-location-kind" name="kind" defaultValue={location.kind}>
            {LOCATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {LOCATION_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </FormField>
        <Checkbox
          label="Activa"
          description="Una ubicación con existencias o reservas no se puede desactivar."
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        <div className="inv-form-actions">
          <Button type="submit" size="sm" isLoading={pending}>
            Guardar
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function EditWarehouseDrawer({
  warehouse,
  onClose,
}: {
  warehouse: WarehouseDTO;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(updateWarehouseAction, EMPTY_FORM_STATE);
  const [active, setActive] = useState(warehouse.active);
  useRefreshOnSuccess(state.success);

  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  return (
    <Drawer open onClose={onClose} title={warehouse.name} subtitle={`Clave ${warehouse.key}`}>
      <form action={action} className="inv-form">
        {state.error ? <Alert variant="error">{state.error}</Alert> : null}
        <input type="hidden" name="warehouseId" value={warehouse.id} />
        <input type="hidden" name="active" value={String(active)} />
        <FormField label="Nombre" htmlFor="inv-edit-warehouse-name">
          <Input
            id="inv-edit-warehouse-name"
            name="name"
            defaultValue={warehouse.name}
            required
            maxLength={120}
          />
        </FormField>
        <Checkbox
          label="Activa"
          description="Una bodega con existencias o reservas no se puede desactivar."
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        {warehouse.zohoLocationId ? (
          <Alert variant="info">
            Ligada a la ubicación {warehouse.zohoLocationId} de Zoho. El enlace se administra desde
            la sincronización.
          </Alert>
        ) : null}
        <div className="inv-form-actions">
          <Button type="submit" size="sm" isLoading={pending}>
            Guardar
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export function LocationsAdmin({
  warehouses,
  selectedWarehouseId,
  labels,
  labelKind,
  canManage,
}: LocationsAdminProps) {
  const router = useRouter();
  const [editingLocation, setEditingLocation] = useState<LocationDTO | null>(null);
  const [editingWarehouse, setEditingWarehouse] = useState<WarehouseDTO | null>(null);

  const selected =
    warehouses.find((warehouse) => warehouse.id === selectedWarehouseId) ?? warehouses[0] ?? null;

  if (warehouses.length === 0) {
    return (
      <div className="area-space">
        <Alert variant="info">
          Todavía no hay bodegas. Crea la primera: se genera con su ubicación GENERAL y a partir de
          ahí el mapa, los conteos y las reservas funcionan.
        </Alert>
        {canManage ? <CreateWarehouseForm /> : null}
      </div>
    );
  }

  return (
    <div className="area-space">
      <div className="inv-toolbar inv-no-print">
        <FormField label="Bodega" htmlFor="inv-admin-warehouse">
          <Select
            id="inv-admin-warehouse"
            value={selected?.id ?? ''}
            onChange={(event) =>
              router.push(
                inventoryHref(INVENTORY_SPACES.locations, {
                  bodega: event.target.value,
                  etiquetas: labelKind === 'container' ? 'contenedores' : null,
                })
              )
            }
          >
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
                {warehouse.active ? '' : ' (inactiva)'}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="inv-toolbar-spacer" />
        {selected ? (
          <Link
            className="btn btn-secondary btn-sm"
            href={inventoryHref(INVENTORY_SPACES.map, { bodega: selected.id })}
          >
            Ver en el mapa
          </Link>
        ) : null}
        {canManage && selected ? (
          <Button variant="secondary" size="sm" onClick={() => setEditingWarehouse(selected)}>
            <Pencil size={14} aria-hidden="true" />
            Editar bodega
          </Button>
        ) : null}
      </div>

      {selected ? (
        <>
          <section aria-labelledby="inv-admin-locations">
            <h3 id="inv-admin-locations" className="area-drawer-section-title">
              Ubicaciones de {selected.name}
            </h3>
            {selected.locations.length === 0 ? (
              <p className="inv-card-hint">
                Esta bodega sólo tiene su ubicación GENERAL. Crea racks o casilleros para contar por
                zona.
              </p>
            ) : (
              <div className="inv-table-wrap">
                <table className="inv-table">
                  <caption className="sr-only">Ubicaciones de la bodega</caption>
                  <thead>
                    <tr>
                      <th scope="col">Código</th>
                      <th scope="col">Nombre</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Estado</th>
                      <th scope="col">
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.locations.map((location) => (
                      <tr key={location.id}>
                        <th scope="row">{location.code}</th>
                        <td>{location.label ?? '—'}</td>
                        <td>{location.kindLabel}</td>
                        <td>
                          {location.active ? (
                            <Badge variant="success">Activa</Badge>
                          ) : (
                            <Badge variant="weak">Inactiva</Badge>
                          )}
                        </td>
                        <td>
                          {canManage ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingLocation(location)}
                            >
                              Editar
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {canManage ? <CreateLocationForm warehouseId={selected.id} /> : null}
          {canManage ? <CreateWarehouseForm /> : null}

          <section aria-labelledby="inv-admin-labels">
            <h3 id="inv-admin-labels" className="area-drawer-section-title">
              Etiquetas para imprimir
            </h3>
            <div className="area-chips inv-no-print" role="group" aria-label="Tipo de etiqueta">
              <Link
                className={`area-chip ${labelKind === 'location' ? 'area-chip-active' : ''}`}
                href={inventoryHref(INVENTORY_SPACES.locations, { bodega: selected.id })}
                aria-current={labelKind === 'location' ? 'true' : undefined}
              >
                Ubicaciones
              </Link>
              <Link
                className={`area-chip ${labelKind === 'container' ? 'area-chip-active' : ''}`}
                href={inventoryHref(INVENTORY_SPACES.locations, {
                  bodega: selected.id,
                  etiquetas: 'contenedores',
                })}
                aria-current={labelKind === 'container' ? 'true' : undefined}
              >
                Rollos, placas y contenedores
              </Link>
            </div>
            <LabelSheet
              labels={labels}
              emptyText={
                labelKind === 'location'
                  ? 'Esta bodega no tiene ubicaciones activas que etiquetar.'
                  : 'Esta bodega no tiene rollos, placas ni contenedores con etiqueta.'
              }
            />
          </section>
        </>
      ) : null}

      {editingLocation ? (
        <EditLocationDrawer location={editingLocation} onClose={() => setEditingLocation(null)} />
      ) : null}
      {editingWarehouse ? (
        <EditWarehouseDrawer
          warehouse={editingWarehouse}
          onClose={() => setEditingWarehouse(null)}
        />
      ) : null}
    </div>
  );
}
