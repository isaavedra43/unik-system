import { areaHref } from '@/modules/areas/area-registry';
import {
  MANUFACTURING_BOM_PATH,
  MANUFACTURING_WORK_CENTERS_PATH,
} from '@/modules/manufacturing/manufacturing-types';

/**
 * Secciones de Manufactura (plan entrega 6, orden de trabajo «6) UI»).
 *
 * El área tiene sus cuatro espacios en el registro (panel, centro de trabajo,
 * comunicaciones y el tablero de producción) y su subpágina de órdenes, pero
 * DOS superficies de gestión viven fuera de `/app/areas`: las listas de
 * materiales y los centros de trabajo. Nadie enlazaba la primera, así que la
 * única manera de crear, versionar, activar o retirar una lista era teclear la
 * URL: la entrega 6 prometía esa gestión y la interfaz no la ofrecía.
 *
 * Esta tira es el equivalente de `CONTABILIDAD_SECTIONS` para Manufactura y se
 * pinta con el `TabNav` compartido, así que no trae componente ni CSS propios.
 *
 * Los permisos son EXACTAMENTE los que exige cada destino:
 * - `tablero` y `ordenes` viven bajo `/app/areas`, cuya puerta es
 *   `areaViewPermissions` (las claves del módulo **o** `operations.admin`).
 * - `bom` y `centros` llaman `requirePermission('manufacturing.view')`, y
 *   `operations.admin` NO implica esa clave: ofrecérselo sería un enlace a un
 *   403.
 */

export const MANUFACTURA_AREA_KEY = 'manufactura';

/** Slug de la vista especial del área en el registro (`special.slug`). */
export const MANUFACTURA_BOARD_SLUG = 'tablero';
/** Slug de la subpágina de órdenes del área (`subpages[0].slug`). */
export const MANUFACTURA_ORDERS_SLUG = 'ordenes';

/** Una sección de Manufactura: dónde se atiende de verdad cada cosa. */
export interface ManufacturaSection {
  id: string;
  label: string;
  href: string;
  description: string;
  /** Cualquiera de estas la abre; la página lo vuelve a exigir en el servidor. */
  anyOf: readonly string[];
}

export const MANUFACTURA_SECTIONS: readonly ManufacturaSection[] = [
  {
    id: MANUFACTURA_BOARD_SLUG,
    label: 'Tablero de producción',
    href: areaHref(MANUFACTURA_AREA_KEY, MANUFACTURA_BOARD_SLUG),
    description: 'Carga por centro y turno con las órdenes en curso.',
    anyOf: ['manufacturing.view', 'operations.admin'],
  },
  {
    id: MANUFACTURA_ORDERS_SLUG,
    label: 'Órdenes de producción',
    href: areaHref(MANUFACTURA_AREA_KEY, MANUFACTURA_ORDERS_SLUG),
    description: 'Órdenes de producción con material, avance y calidad.',
    anyOf: ['manufacturing.view', 'operations.admin'],
  },
  {
    id: 'bom',
    label: 'Listas de materiales',
    href: MANUFACTURING_BOM_PATH,
    description: 'Recetas versionadas: insumos, sustitutos y ruta por centro.',
    anyOf: ['manufacturing.view'],
  },
  {
    id: 'centros',
    label: 'Centros de trabajo',
    href: MANUFACTURING_WORK_CENTERS_PATH,
    description: 'Dónde se produce, con cuánta capacidad y en qué turnos.',
    anyOf: ['manufacturing.view'],
  },
];

export interface ManufacturaPermissionHolder {
  permissionKeys: readonly string[];
  isSuperAdmin?: boolean;
}

/** Secciones que esta persona puede abrir de verdad (sin enlaces a un 403). */
export function visibleManufacturaSections(
  user: ManufacturaPermissionHolder
): ManufacturaSection[] {
  return MANUFACTURA_SECTIONS.filter(
    (section) =>
      user.isSuperAdmin === true || section.anyOf.some((key) => user.permissionKeys.includes(key))
  );
}

export function manufacturaSection(id: string): ManufacturaSection | null {
  return MANUFACTURA_SECTIONS.find((section) => section.id === id) ?? null;
}

/** Forma que pide el `TabNav` compartido (`@/components/ui/composite`). */
export function manufacturaSectionTabs(
  user: ManufacturaPermissionHolder
): Array<{ id: string; label: string; href: string }> {
  return visibleManufacturaSections(user).map(({ id, label, href }) => ({ id, label, href }));
}
