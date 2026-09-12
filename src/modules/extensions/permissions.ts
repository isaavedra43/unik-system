import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Extensions module permissions (MCP, APIs, plugins, skills, connections).
 * Administration requires its own keys: having access to the assistant is
 * never enough to publish or approve an extension.
 */
export const EXTENSIONS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'extensions.view',
    group: 'Extensiones',
    label: 'Ver extensiones',
    description: 'Permite ver el catálogo, ejecuciones y consumo de extensiones del asistente',
  },
  {
    key: 'extensions.manage',
    group: 'Extensiones',
    label: 'Administrar extensiones',
    description:
      'Permite crear, importar, probar, clasificar, aprobar, asignar equipos y suspender extensiones (MCP, APIs, plugins)',
  },
  {
    key: 'extensions.connect',
    group: 'Extensiones',
    label: 'Conectar cuentas propias',
    description:
      'Permite al usuario conectar y desconectar su propia cuenta en extensiones que lo admiten',
  },
  {
    key: 'skills.manage',
    group: 'Extensiones',
    label: 'Publicar skills de equipo',
    description:
      'Permite revisar y publicar skills compartidas para equipos (las personales no requieren este permiso)',
  },
];
