import { PermissionDefinition } from '@/modules/auth/permissions';

export const VOICE_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'calls.use',
    group: 'Telefonía',
    label: 'Realizar y atender llamadas',
    description:
      'Permite llamadas internas y externas con copiloto de IA, pausa y grabación con controles visibles',
  },
  {
    key: 'calls.supervise',
    group: 'Telefonía',
    label: 'Supervisar llamadas',
    description:
      'Permite listar, escuchar, leer transcripciones e intervenir en llamadas de los equipos permitidos',
  },
  {
    key: 'calls.admin',
    group: 'Telefonía',
    label: 'Administrar telefonía',
    description: 'Permite configurar LiveKit, Twilio, retención y políticas de grabación',
  },
];
