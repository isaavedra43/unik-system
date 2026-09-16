import type { ReactNode } from 'react';
// Hoja de expedientes (sólo tokens). Next permite CSS global desde un layout.
import '@/styles/operations/case-360.css';

export const runtime = 'nodejs';

/**
 * Shell of the operational cases: the list (`/app/operations`) and the
 * Expediente 360 (`/app/operations/cases/[id]`). Each page applies its own
 * rule — the list needs `operations.view` (or shows only your own cases) and
 * the case applies `authorizeOperationsChannel('case')` — so this layout only
 * loads the stylesheet they share.
 */
export default function OperationsLayout({ children }: { children: ReactNode }) {
  return children;
}
