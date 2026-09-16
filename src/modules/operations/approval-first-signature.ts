import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Firma de negocio heredada de la decisión sobre una propuesta de IA (plan 5.4:
 * «si quien aprueba la propuesta de IA cumple la política, esa decisión se
 * registra también como primera firma de negocio para no pedir dos clics por lo
 * mismo»).
 *
 * `approveProposal` envuelve la ejecución de la herramienta aprobada con
 * `runWithApprovalFirstSignature`; si esa ejecución abre una `ApprovalRequest`,
 * `requestApproval` toma la firma con `takeApprovalFirstSignature` y la guarda
 * como el primer voto de la solicitud. Así la persona que ya revisó la tarjeta
 * no vuelve a aparecer excluida de su propia solicitud (`checkVote` devolvía
 * `self_approval` para el solicitante).
 *
 * Reglas del mecanismo:
 * - se consume UNA sola vez por decisión: si la herramienta abriera dos
 *   aprobaciones, sólo la primera hereda la firma;
 * - sólo la toma la aprobación cuyo solicitante es exactamente esa persona (la
 *   que abrió su propio clic), nunca una pedida en nombre de alguien más;
 * - quien la recibe todavía tiene que cumplir la política (`requestApproval`
 *   comprueba que sea aprobador elegible antes de registrarla).
 *
 * El `AsyncLocalStorage` vive en `globalThis` a propósito: Next compila cada
 * módulo de servidor una vez por CAPA de webpack, así que un estado de módulo
 * suelto existiría varias veces y `extensions` (quien la pone) no vería la
 * misma instancia que `operations` (quien la toma).
 */
export interface ApprovalFirstSignature {
  /** Persona que decidió la propuesta de IA; su clic es la primera firma. */
  userId: string;
  /** `AiProposal.id` que llevó la decisión (queda en la nota del voto). */
  proposalId: string;
  /** Herramienta que ejecutó esa aprobación. */
  toolName: string;
  /** Ya la tomó una `ApprovalRequest`: no se hereda a una segunda. */
  used: boolean;
}

type GlobalWithSignature = typeof globalThis & {
  __unikApprovalFirstSignature?: AsyncLocalStorage<ApprovalFirstSignature>;
};

function store(): AsyncLocalStorage<ApprovalFirstSignature> {
  const scope = globalThis as GlobalWithSignature;
  if (!scope.__unikApprovalFirstSignature) {
    scope.__unikApprovalFirstSignature = new AsyncLocalStorage<ApprovalFirstSignature>();
  }
  return scope.__unikApprovalFirstSignature;
}

/** Ejecuta `fn` marcando que la decisión de `proposalId` la tomó `userId`. */
export function runWithApprovalFirstSignature<T>(
  signature: Omit<ApprovalFirstSignature, 'used'>,
  fn: () => Promise<T>
): Promise<T> {
  return store().run({ ...signature, used: false }, fn);
}

/**
 * Toma (y consume) la firma pendiente cuando el solicitante de la aprobación es
 * la misma persona que decidió la propuesta. Devuelve null fuera de ese caso.
 */
export function takeApprovalFirstSignature(
  requestedByUserId: string
): ApprovalFirstSignature | null {
  const current = store().getStore();
  if (!current || current.used || current.userId !== requestedByUserId) return null;
  current.used = true;
  return current;
}

/** Lectura sin consumir (diagnóstico y pruebas). */
export function peekApprovalFirstSignature(): ApprovalFirstSignature | null {
  return store().getStore() ?? null;
}
