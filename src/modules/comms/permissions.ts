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
  {
    key: 'requests.use',
    group: 'Comunicaciones',
    label: 'Solicitudes internas',
    description: 'Permite crear y dar seguimiento a solicitudes internas con expediente',
  },
  {
    key: 'quotes.use',
    group: 'Comunicaciones',
    label: 'Preparar cotizaciones',
    description: 'Permite preparar cotizaciones en borrador',
  },
  {
    key: 'quotes.approve',
    group: 'Comunicaciones',
    label: 'Aprobar cotizaciones oficiales',
    description: 'Permite aprobar cotizaciones y crearlas en Zoho Books',
  },
];
