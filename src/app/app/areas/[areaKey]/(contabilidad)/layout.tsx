import type { ReactNode } from 'react';
// Hoja del área (sólo tokens). Next permite CSS global desde un layout.
import '@/styles/operations/contabilidad.css';

export const runtime = 'nodejs';

/**
 * Management pages of Contabilidad. The area layout above already gated the
 * area and loaded the registrations; this one only brings the stylesheet the
 * pages share. Each page renders `AreaWorkspaceShell` itself so the area tabs
 * and the realtime chip stay in place.
 */
export default function ContabilidadLayout({ children }: { children: ReactNode }) {
  return children;
}
