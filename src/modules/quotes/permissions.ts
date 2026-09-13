import { PermissionDefinition } from '@/modules/auth/permissions';

export const QUOTES_PERMISSIONS: PermissionDefinition[] = [
  { key: 'quotes.view', group: 'Cotizaciones', label: 'Ver cotizaciones', description: 'Permite consultar el workspace de cotizaciones de Zoho Books y abrir el detalle' },
  { key: 'quotes.create', group: 'Cotizaciones', label: 'Crear cotizaciones', description: 'Permite crear cotizaciones desde UNIK; se registran en Zoho Books' },
  { key: 'quotes.edit', group: 'Cotizaciones', label: 'Editar cotizaciones', description: 'Permite editar cotizaciones en borrador o enviadas; los cambios se aplican en Zoho Books' },
  { key: 'quotes.change_status', group: 'Cotizaciones', label: 'Cambiar estado de cotizaciones', description: 'Permite marcar cotizaciones como enviadas, aceptadas o rechazadas en Zoho Books' },
  { key: 'quotes.send_email', group: 'Cotizaciones', label: 'Enviar cotizaciones por correo', description: 'Permite enviar la cotización al cliente usando el correo y PDF oficial de Zoho' },
  { key: 'quotes.export', group: 'Cotizaciones', label: 'Exportar cotizaciones', description: 'Permite exportar cotizaciones a CSV o Excel' },
  { key: 'quotes.watch', group: 'Cotizaciones', label: 'Seguir cotizaciones', description: 'Permite marcar cotizaciones para recibir notificaciones cuando cambien' },
  { key: 'quotes.share_views', group: 'Cotizaciones', label: 'Compartir vistas de cotizaciones', description: 'Permite compartir vistas guardadas con otros usuarios de UNIK' },
];

export const QUOTE_ENTITY_TYPE = 'quote';
