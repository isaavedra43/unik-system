import { PermissionDefinition } from '@/modules/auth/permissions';

export const VISUAL_STUDIO_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'visual_studio.view',
    group: 'Visual Studio',
    label: 'Ver Visual Studio',
    description: 'Permite abrir proyectos visuales y ver propuestas',
  },
  {
    key: 'visual_studio.edit',
    group: 'Visual Studio',
    label: 'Editar proyectos visuales',
    description: 'Permite crear proyectos, subir fotografías y editar máscaras',
  },
  {
    key: 'visual_studio.generate',
    group: 'Visual Studio',
    label: 'Generar propuestas',
    description: 'Permite solicitar generaciones al proveedor de imágenes (consume créditos)',
  },
  {
    key: 'visual_studio.select',
    group: 'Visual Studio',
    label: 'Seleccionar propuesta del cliente',
    description: 'Permite marcar la propuesta elegida por el cliente para seguimiento comercial',
  },
  {
    key: 'visual_studio.media',
    group: 'Visual Studio',
    label: 'Gestionar imágenes de producto',
    description: 'Permite agregar fotografías de referencia a productos del catálogo',
  },
];
