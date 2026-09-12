import { PermissionDefinition } from '@/modules/auth/permissions';

export const COMMS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'inbox.use',
    group: 'Comunicaciones',
    label: 'Usar la bandeja',
    description:
      'Permite ver y responder conversaciones de WhatsApp, SMS y Telegram de sus equipos',
  },
  {
    key: 'inbox.assign',
    group: 'Comunicaciones',
    label: 'Asignar conversaciones',
    description: 'Permite asignar conversaciones a otros usuarios y cambiar su estado',
  },
  {
    key: 'inbox.admin',
    group: 'Comunicaciones',
    label: 'Administrar canales',
    description: 'Permite configurar números, bots, equipos y responsables',
  },
];
