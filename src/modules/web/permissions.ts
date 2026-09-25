import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Internet access for the assistant/agents. Read-only egress: nothing here can
 * send data out — posting/purchasing/credentials live in the venue tools.
 */
export const WEB_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'web.search',
    group: 'Agentes e Internet',
    label: 'Buscar en internet',
    description: 'Permite al asistente buscar en la web (proveedor de búsqueda configurado)',
  },
  {
    key: 'web.fetch',
    group: 'Agentes e Internet',
    label: 'Leer páginas web',
    description: 'Permite al asistente abrir URLs públicas y leer su contenido',
  },
  {
    key: 'web.crawl',
    group: 'Agentes e Internet',
    label: 'Rastrear sitios web',
    description: 'Permite al asistente seguir enlaces dentro de un mismo sitio (acotado)',
  },
];
