import { PermissionDefinition } from '@/modules/auth/permissions';

export const CAMPAIGNS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'campaigns.view',
    group: 'Campañas',
    label: 'Ver campañas',
    description: 'Permite ver campañas, audiencias congeladas y resultados',
  },
  {
    key: 'campaigns.manage',
    group: 'Campañas',
    label: 'Crear y ensayar campañas',
    description: 'Permite crear campañas, congelar audiencia y contenido, ensayar y programar',
  },
  {
    key: 'campaigns.approve',
    group: 'Campañas',
    label: 'Aprobar envíos masivos',
    description: 'Permite aprobar el envío real de una campaña con presupuesto',
  },
];
