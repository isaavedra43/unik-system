/**
 * Traspaso de un borrador entre dos superficies del área (plan 7.6): el
 * copiloto del Radar de cierre redacta un mensaje para el cliente y ese texto
 * tiene que aparecer en el redactor de la bandeja externa
 * (`InboxEmbedded`), que vive en OTRA página (`/app/areas/<area>/comunicaciones`).
 *
 * Por qué `sessionStorage` y no la URL: el borrador es texto escrito para una
 * persona concreta (nombre, importes, condiciones). Nunca viaja en un parámetro
 * de consulta — ni queda en el historial del navegador, ni en los registros del
 * servidor. Se guarda en la pestaña, se consume UNA vez y se borra.
 *
 * Módulo PURO respecto de React: no importa nada del framework y funciona en el
 * servidor (donde no hay `sessionStorage`) devolviendo `null`.
 */

const PREFIX = 'unik:area-comms-draft:';
/** Un borrador viejo es ruido: si nadie lo usó en 30 minutos, se descarta. */
export const COMMS_DRAFT_TTL_MS = 30 * 60_000;
const MAX_LENGTH = 8000;

export interface CommsDraft {
  text: string;
  /** Milisegundos epoch en que se guardó. */
  createdAt: number;
  /** De dónde salió, para que la bandeja pueda decirlo ('radar', 'copiloto'…). */
  origin?: string;
}

export function commsDraftKey(areaKey: string): string {
  return `${PREFIX}${areaKey}`;
}

/** Almacén que usa el módulo; separado para poder probarlo sin navegador. */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): DraftStore | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    // Safari en modo privado y las políticas de almacenamiento bloqueado lanzan aquí.
    return null;
  }
}

/** Serializa un borrador; `null` cuando no hay nada que guardar. */
export function serializeCommsDraft(text: string, now: number, origin?: string): string | null {
  const clean = text.trim().slice(0, MAX_LENGTH);
  if (!clean) return null;
  const draft: CommsDraft = { text: clean, createdAt: now, ...(origin ? { origin } : {}) };
  return JSON.stringify(draft);
}

/** Lee un borrador serializado; `null` si está vacío, roto o vencido. */
export function parseCommsDraft(raw: string | null, now: number): CommsDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim().slice(0, MAX_LENGTH) : '';
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0;
  if (!text || !Number.isFinite(createdAt)) return null;
  if (now - createdAt > COMMS_DRAFT_TTL_MS || createdAt - now > 60_000) return null;
  const origin = typeof record.origin === 'string' ? record.origin.slice(0, 40) : undefined;
  return { text, createdAt, ...(origin ? { origin } : {}) };
}

/** Guarda el borrador para el área. Devuelve `false` si no había dónde guardarlo. */
export function stashCommsDraft(
  areaKey: string,
  text: string,
  options: { now?: number; origin?: string; store?: DraftStore | null } = {}
): boolean {
  const store = options.store === undefined ? defaultStore() : options.store;
  if (!store) return false;
  const value = serializeCommsDraft(text, options.now ?? Date.now(), options.origin);
  if (!value) return false;
  try {
    store.setItem(commsDraftKey(areaKey), value);
    return true;
  } catch {
    return false;
  }
}

/** Consume el borrador del área: lo devuelve y lo borra (nunca se usa dos veces). */
export function takeCommsDraft(
  areaKey: string,
  options: { now?: number; store?: DraftStore | null } = {}
): CommsDraft | null {
  const store = options.store === undefined ? defaultStore() : options.store;
  if (!store) return null;
  const key = commsDraftKey(areaKey);
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  try {
    store.removeItem(key);
  } catch {
    // Da igual: si no se puede borrar, la caducidad lo descarta.
  }
  return parseCommsDraft(raw, options.now ?? Date.now());
}
