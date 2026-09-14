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
  'system',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface CategoryDefinition {
  key: NotificationCategory;
  label: string;
  description: string;
  group: 'Llamadas' | 'Mensajes' | 'Asistente IA' | 'Seguimiento' | 'Sistema';
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
    description: 'Órdenes, cotizaciones, facturas, clientes y demás registros que marcaste como seguidos.',
    group: 'Seguimiento',
    defaults: { inApp: true, push: true },
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
