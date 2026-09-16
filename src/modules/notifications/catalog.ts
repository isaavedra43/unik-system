/**
 * Notification catalog: every notification belongs to exactly one category,
 * and the user configures in-app / push delivery per category from
 * /app/account/notifications. Adding a category here is enough for it to show
 * up in the settings screen with its defaults.
 */

export const NOTIFICATION_CATEGORIES = [
  'call_incoming',
  'call_missed',
  'call_summary',
  'chat_message',
  'chat_mention',
  'inbox_message',
  'inbox_assigned',
  'ai_task_done',
  'ai_user_message',
  'entity_change',
  'ops_workitem',
  'ops_escalation',
  'ops_incident',
  'ops_request',
  'approval_requested',
  'approval_decided',
  'purchase_update',
  'delivery_update',
  'production_update',
  'finance_alert',
  'radar_signal',
  'agent_request',
  'agent_proposal',
  'agent_budget',
  'system',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface CategoryDefinition {
  key: NotificationCategory;
  label: string;
  description: string;
  group: 'Llamadas' | 'Mensajes' | 'Asistente IA' | 'Seguimiento' | 'Operaciones' | 'Sistema';
  defaults: { inApp: boolean; push: boolean };
  /** Skips quiet hours and mute (the user still needs push enabled for the category). */
  urgent?: boolean;
  /** Cannot be turned off in-app (it is the audit trail of what happened). */
  lockedInApp?: boolean;
}

export const NOTIFICATION_CATALOG: CategoryDefinition[] = [
  {
    key: 'call_incoming',
    label: 'Llamada entrante',
    description: 'Cuando entra una llamada dirigida a ti o a tu equipo.',
    group: 'Llamadas',
    defaults: { inApp: true, push: true },
    urgent: true,
  },
  {
    key: 'call_missed',
    label: 'Llamada perdida',
    description: 'Una llamada que no se contestó, con el número y quién llamaba.',
    group: 'Llamadas',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'call_summary',
    label: 'Resumen de llamada',
    description: 'Cuando la IA termina de transcribir y resumir una llamada tuya.',
    group: 'Llamadas',
    defaults: { inApp: true, push: false },
  },
  {
    key: 'chat_message',
    label: 'Mensaje en chat interno',
    description: 'Mensajes nuevos en canales y directos donde participas.',
    group: 'Mensajes',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'chat_mention',
    label: 'Mención en chat interno',
    description: 'Alguien te menciona con @ en el chat interno.',
    group: 'Mensajes',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'inbox_message',
    label: 'Mensaje de cliente en bandeja',
    description: 'Un cliente escribe en una conversación asignada a ti (WhatsApp, SMS, email).',
    group: 'Mensajes',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'inbox_assigned',
    label: 'Conversación asignada',
    description: 'Te asignan una conversación de la bandeja de entrada.',
    group: 'Mensajes',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'ai_task_done',
    label: 'La IA terminó una tarea',
    description: 'El asistente terminó algo que le pediste (reportes, análisis largos, acciones).',
    group: 'Asistente IA',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'ai_user_message',
    label: 'Aviso enviado por la IA',
    description: 'Otro usuario le pidió a la IA que te avise algo.',
    group: 'Asistente IA',
    defaults: { inApp: true, push: true },
    lockedInApp: true,
  },
  {
    key: 'entity_change',
    label: 'Cambios en lo que sigues',
    description:
      'Órdenes, cotizaciones, facturas, clientes y demás registros que marcaste como seguidos.',
    group: 'Seguimiento',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'ops_workitem',
    label: 'Trabajo asignado',
    description:
      'Te toca un trabajo de un expediente (verificar, preparar, entregar...), con su vencimiento.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'ops_escalation',
    label: 'Trabajo vencido o escalado',
    description: 'Un trabajo tuyo o de tu área venció y se escaló a ti.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
    urgent: true,
  },
  {
    key: 'ops_incident',
    label: 'Incidencia operativa',
    description:
      'Se abrió una incidencia en tu área (conflicto de inventario, falla con Zoho, entrega parcial...).',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'ops_request',
    label: 'Solicitud de otra área',
    description:
      'Otra área te pide algo sobre un expediente (compra, producción, entrega, aviso al cliente...).',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'approval_requested',
    label: 'Aprobación pendiente',
    description: 'Una compra, gasto, pago o ajuste espera tu aprobación.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'approval_decided',
    label: 'Aprobación resuelta',
    description: 'Se aprobó o rechazó algo que solicitaste.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'purchase_update',
    label: 'Movimiento de una compra',
    description:
      'Avances de compras que te tocan: cotizaciones respondidas, órdenes aprobadas o enviadas al proveedor, diferencias en una recepción.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'delivery_update',
    label: 'Movimiento de una entrega',
    description:
      'Avances de logística: viajes que salen, paradas entregadas, entregas con conflicto o reprogramadas.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'production_update',
    label: 'Movimiento de producción',
    description:
      'Avances de manufactura: órdenes liberadas, material preparado, merma fuera de tolerancia.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'finance_alert',
    label: 'Alerta de contabilidad',
    description:
      'Obligaciones vencidas o por vencer, cierres del día pendientes y otros avisos del dinero.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'radar_signal',
    label: 'Señal del radar de ventas',
    description:
      'Oportunidades que se enfrían, cotizaciones por vencer y otras señales del radar. Llegan a la aplicación; el push viene apagado.',
    group: 'Seguimiento',
    defaults: { inApp: true, push: false },
  },
  {
    key: 'agent_request',
    label: 'Solicitud anunciada por la IA de un área',
    description:
      'La IA de otra área te avisa de una solicitud sobre un expediente, con acciones rápidas para aceptarla o bloquearla.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'agent_proposal',
    label: 'Propuesta de la IA que puedes aprobar',
    description:
      'La IA de un área propone una acción (reservar, pedir compra, asignar transportista...) y tú estás entre quienes la aprueban.',
    group: 'Operaciones',
    defaults: { inApp: true, push: true },
  },
  {
    key: 'agent_budget',
    label: 'Presupuesto de la IA de un área',
    description:
      'La IA de un área llegó a su límite diario de tokens o mensual de costo y pasó a modo bajo demanda o en pausa.',
    group: 'Operaciones',
    defaults: { inApp: true, push: false },
  },
  {
    key: 'system',
    label: 'Sistema',
    description: 'Avisos administrativos, seguridad y mantenimiento.',
    group: 'Sistema',
    defaults: { inApp: true, push: false },
    lockedInApp: true,
  },
];

const BY_KEY = new Map(NOTIFICATION_CATALOG.map((c) => [c.key, c]));

export function getCategoryDefinition(key: string): CategoryDefinition {
  return BY_KEY.get(key as NotificationCategory) ?? BY_KEY.get('system')!;
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return BY_KEY.has(value as NotificationCategory);
}
