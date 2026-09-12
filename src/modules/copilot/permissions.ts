import { PermissionDefinition } from '@/modules/auth/permissions';

/** Approved knowledge library administration (users read it through the assistant). */
export const KNOWLEDGE_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'knowledge.manage',
    group: 'Biblioteca aprobada',
    label: 'Administrar la biblioteca',
    description:
      'Permite subir fuentes, aprobar versiones y definir qué información es interna o publicable',
  },
];
