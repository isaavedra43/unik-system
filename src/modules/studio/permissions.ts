import { PermissionDefinition } from '@/modules/auth/permissions';

export const STUDIO_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'studio.use',
    group: 'Estudio visual',
    label: 'Usar el estudio',
    description:
      'Permite crear y editar documentos e imágenes, versiones, plantillas y exportaciones',
  },
  {
    key: 'studio.approve',
    group: 'Estudio visual',
    label: 'Aprobar y compartir documentos',
    description: 'Permite aprobar una versión de documento y compartirla con el equipo',
  },
];
