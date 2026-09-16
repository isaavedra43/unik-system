import type { ReactNode } from 'react';
// Hojas de esta superficie. Next permite CSS global desde un layout; la de
// React Flow es obligatoria para que el lienzo se posicione bien, y
// `neural-ops.css` la reviste con los tokens de UNIK (`--xy-*` → `--unik-*`).
import '@xyflow/react/dist/style.css';
import '@/styles/operations/neural-ops.css';
import { requireAnyPermission } from '@/modules/auth/authorization';
import { CONTROL_TOWER_PERMISSION } from '@/modules/control-tower/control-tower-service';

export const runtime = 'nodejs';

/**
 * Gate de UNIK Neural Operations (plan 7.8): toda la superficie exige
 * `operations.admin`, igual que el resto de la Torre de Control.
 *
 * Los servicios vuelven a comprobarlo (`assertControlTowerAccess`), así que una
 * página nueva que olvide este gate sigue sin devolver datos; esto sólo evita
 * pagar la consulta y da el 403 correcto.
 */
export default async function NeuralLayout({ children }: { children: ReactNode }) {
  await requireAnyPermission([CONTROL_TOWER_PERMISSION]);
  return children;
}
