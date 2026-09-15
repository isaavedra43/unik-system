import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Logistics permissions (code-first registry, no migration).
 *
 * - `logistics.view`: see delivery orders, trips, stops, fleet and evidence.
 * - `logistics.dispatch`: plan deliveries, assign transport, build and operate
 *   trips, cancel deliveries and record deliveries on behalf of a driver.
 * - `logistics.drive`: driver PWA — see today's trips and operate only the
 *   stops of the trips assigned to the driver linked to the user.
 * - `logistics.manage_fleet`: create and edit vehicles and drivers; also allows
 *   building a trip over the vehicle capacity.
 * - `logistics.zoho_write`: request writes to Zoho (shipment orders) when
 *   assigning transport. Without it a dispatcher can plan but not ship.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const LOGISTICS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'logistics.view',
    group: 'Logística',
    label: 'Ver logística',
    description: 'Permite consultar órdenes de entrega, viajes, paradas, flotilla y evidencias',
  },
  {
    key: 'logistics.dispatch',
    group: 'Logística',
    label: 'Despachar entregas',
    description:
      'Permite planear entregas, asignar transporte, armar y operar viajes y cancelar entregas',
  },
  {
    key: 'logistics.drive',
    group: 'Logística',
    label: 'Operar como chofer',
    description:
      'Permite ver los viajes del día y registrar llegadas, entregas y evidencias de sus paradas',
  },
  {
    key: 'logistics.manage_fleet',
    group: 'Logística',
    label: 'Gestionar flotilla',
    description:
      'Permite dar de alta y editar vehículos y choferes, y autorizar viajes sobre la capacidad',
  },
  {
    key: 'logistics.zoho_write',
    group: 'Logística',
    label: 'Escribir embarques en Zoho',
    description: 'Permite enviar a Zoho las órdenes de envío al asignar transportista',
  },
];
