/**
 * Concordancia de género de las frases que `EntityWorkspace` arma con el nombre
 * de la entidad.
 *
 * Hasta ahora todas las tablas eran masculinas (pedidos, paquetes, contactos) y
 * el artículo estaba fijo en «los», así que Excepciones salía como «Todos los
 * excepciones». Las funciones son puras y no dependen de React para poder
 * probarse solas.
 */

export type EntityGender = 'm' | 'f';

/** «el» / «la». */
export function definiteArticle(gender: EntityGender): string {
  return gender === 'f' ? 'la' : 'el';
}

/** «los» / «las». */
export function definiteArticlePlural(gender: EntityGender): string {
  return gender === 'f' ? 'las' : 'los';
}

/** «Todos los pedidos» · «Todas las excepciones». */
export function allEntitiesLabel(pluralLabel: string, gender: EntityGender): string {
  const all = gender === 'f' ? 'Todas' : 'Todos';
  return `${all} ${definiteArticlePlural(gender)} ${pluralLabel.toLowerCase()}`;
}

/**
 * Participio concordado: `agree('seguido', 'f', { plural: true })` → «seguidas».
 * El participio se pasa en masculino singular, terminado en «o».
 */
export function agree(
  masculineSingular: string,
  gender: EntityGender,
  options: { plural?: boolean } = {}
): string {
  const stem = masculineSingular.endsWith('o') ? masculineSingular.slice(0, -1) : masculineSingular;
  const vowel = masculineSingular.endsWith('o') ? (gender === 'f' ? 'a' : 'o') : '';
  return `${stem}${vowel}${options.plural ? 's' : ''}`;
}
