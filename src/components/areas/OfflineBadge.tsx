'use client';

import '@/styles/operations/area-mobile.css';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';

/**
 * Connectivity of the operational surfaces (plan 7.10): "Sin conexión · 3
 * pendientes". It reads the offline command queue, which is where every
 * operational action goes when the phone loses signal, so a person always
 * knows whether what they just did is already on the server.
 *
 * `OfflineBadgeView` is the presentational half (pure props, used by the
 * stories); `OfflineBadge` wires it to `useOfflineCommandQueue`.
 *
 * It renders nothing while everything is sent and online: the header stays
 * calm and only speaks when there is something to say.
 */

export interface OfflineBadgeViewProps {
  online: boolean;
  /** Commands of this user still on the device. */
  pending: number;
  /** Commands another person left on this device (sent when they sign in). */
  pendingOtherUsers?: number;
  /** Commands the server kept rejecting: they need a person. */
  stuck?: number;
  flushing?: boolean;
  /** Sends the pending commands now. */
  onFlush?: () => void;
  className?: string;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export function OfflineBadgeView({
  online,
  pending,
  pendingOtherUsers = 0,
  stuck = 0,
  flushing = false,
  onFlush,
  className,
}: OfflineBadgeViewProps) {
  const safePending = Math.max(0, pending);
  const safeStuck = Math.max(0, stuck);
  const safeOthers = Math.max(0, pendingOtherUsers);

  if (online && safePending === 0 && safeStuck === 0 && safeOthers === 0) return null;

  const classes = ['area-offline'];
  let text: string;
  let title: string;
  let showFlush = false;

  if (!online) {
    classes.push('area-offline-warning');
    text =
      safePending > 0
        ? `Sin conexión · ${safePending} ${plural(safePending, 'pendiente', 'pendientes')}`
        : 'Sin conexión';
    title =
      safePending > 0
        ? 'Lo que registres se guarda en este dispositivo y se envía solo al recuperar la señal.'
        : 'Puedes seguir trabajando: lo que registres se enviará al recuperar la señal.';
  } else if (safeStuck > 0) {
    classes.push('area-offline-danger');
    text = `${safeStuck} sin enviar`;
    title =
      'Estas acciones fallaron varias veces y se quedaron en este dispositivo. Vuelve a hacerlas desde la fila correspondiente.';
  } else if (safePending > 0) {
    classes.push('area-offline-info');
    text = `${safePending} por enviar`;
    title = 'Acciones guardadas en este dispositivo que todavía no llegan al servidor.';
    showFlush = Boolean(onFlush);
  } else {
    classes.push('area-offline-info');
    text = `${safeOthers} de otra persona`;
    title =
      'Otra persona dejó acciones sin enviar en este dispositivo; se enviarán cuando inicie sesión.';
  }

  if (className) classes.push(className);

  return (
    <span className={classes.join(' ')} role="status" aria-live="polite" title={title}>
      {online ? (
        <span className="area-offline-dot" aria-hidden="true" />
      ) : (
        <CloudOff size={14} aria-hidden="true" />
      )}
      <span className="area-offline-text">{text}</span>
      {showFlush ? (
        <button
          type="button"
          className="area-offline-action"
          onClick={onFlush}
          disabled={flushing}
          aria-label="Enviar ahora las acciones pendientes"
        >
          <RefreshCw size={12} aria-hidden="true" />
          {flushing ? 'Enviando…' : 'Enviar'}
        </button>
      ) : null}
    </span>
  );
}

export interface OfflineBadgeProps {
  /** Session user: only their commands are counted and sent. */
  userId: string;
  className?: string;
}

export function OfflineBadge({ userId, className }: OfflineBadgeProps) {
  const { online, pending, pendingOtherUsers, stuck, flushing, flush } =
    useOfflineCommandQueue(userId);
  return (
    <OfflineBadgeView
      online={online}
      pending={pending}
      pendingOtherUsers={pendingOtherUsers}
      stuck={stuck}
      flushing={flushing}
      onFlush={() => void flush()}
      className={className}
    />
  );
}
