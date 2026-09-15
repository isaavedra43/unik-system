import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Sales / CRM permissions (code-first registry, no migration). Plan 6.5.
 *
 * - `crm.view`: pipeline, opportunities with their timeline and the CRM panel
 *   of a conversation (the panel also requires access to the inbox account).
 * - `crm.manage`: create opportunities (from a conversation, a call, a quote or
 *   by hand), edit them, move stages, record activities, link quotes and sales
 *   orders, mark won / lost / dormant. It is the action permission of Ventas.
 * - `crm.manage_stages`: create, rename, reorder and deactivate pipeline stages.
 * - `crm.create_sales_order`: convert an accepted quote into a sales order in
 *   Zoho from UNIK (idempotent ledger + read-back).
 * - `crm.radar`: see radar signals, ask the AI to explain them and draft the
 *   message, snooze, dismiss or convert them into a task. Holders see their own
 *   signals and the unassigned ones; `crm.manage` sees every salesperson's.
 * - `crm.export`: export opportunities and signals.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const CRM_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'crm.view',
    group: 'Ventas / CRM',
    label: 'Ver CRM',
    description:
      'Permite consultar el embudo, las oportunidades con su línea de tiempo y el panel CRM de las conversaciones',
  },
  {
    key: 'crm.manage',
    group: 'Ventas / CRM',
    label: 'Gestionar oportunidades',
    description:
      'Permite crear oportunidades, moverlas de etapa, registrar actividades, vincular cotizaciones y órdenes y marcarlas ganadas o perdidas',
  },
  {
    key: 'crm.manage_stages',
    group: 'Ventas / CRM',
    label: 'Configurar etapas del embudo',
    description: 'Permite crear, renombrar, reordenar y desactivar etapas del embudo comercial',
  },
  {
    key: 'crm.create_sales_order',
    group: 'Ventas / CRM',
    label: 'Crear órdenes de venta en Zoho',
    description:
      'Permite convertir una cotización aceptada en orden de venta de Zoho desde UNIK (abre el expediente operativo)',
  },
  {
    key: 'crm.radar',
    group: 'Ventas / CRM',
    label: 'Usar el radar comercial',
    description:
      'Permite ver las señales del radar, pedir a la IA la explicación y el mensaje sugerido, posponerlas, descartarlas o convertirlas en tarea',
  },
  {
    key: 'crm.export',
    group: 'Ventas / CRM',
    label: 'Exportar CRM',
    description: 'Permite exportar oportunidades y señales del radar',
  },
];

export const CRM_PERMISSION_KEYS = CRM_PERMISSIONS.map((p) => p.key);
