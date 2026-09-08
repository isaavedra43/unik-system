import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * AI Assistant module permissions.
 *
 * Only permissions for IMPLEMENTED features are registered here.
 * super_admin bypasses the permission list entirely, so these keys
 * apply automatically to that role without explicit assignment.
 */
export const AI_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'assistant.use',
    group: 'Asistente IA',
    label: 'Usar el asistente',
    description: 'Permite conversar con el asistente de IA y consultar datos de negocio',
  },
  {
    key: 'assistant.upload',
    group: 'Asistente IA',
    label: 'Subir archivos al asistente',
    description: 'Permite adjuntar documentos e imágenes para que la IA los procese',
  },
  {
    key: 'assistant.export',
    group: 'Asistente IA',
    label: 'Generar reportes con IA',
    description: 'Permite que la IA genere reportes en PDF, Excel, CSV e imágenes',
  },
  {
    key: 'assistant.voice',
    group: 'Asistente IA',
    label: 'Usar voz con el asistente',
    description: 'Permite dictar por voz y escuchar respuestas del asistente',
  },
  {
    key: 'assistant.admin',
    group: 'Asistente IA',
    label: 'Administrar el asistente',
    description: 'Permite configurar, monitorear y auditar el asistente de IA',
  },
];
