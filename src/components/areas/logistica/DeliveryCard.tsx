'use client';

import type { ReactNode } from 'react';
import { Clock, MapPin, Package, Truck, User } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import {
  formatDayLabel,
  formatWindow,
  type DispatchDelivery,
} from '@/modules/areas/logistica/logistics-view-model';
import { ZohoSyncPill } from './ZohoSyncPill';

export interface DeliveryCardProps {
  delivery: DispatchDelivery;
  /** Highlights the card selected on the board or pointed at by the map. */
  selected?: boolean;
  /** Opens the detail of the delivery (also fired by keyboard). */
  onOpen?: () => void;
  onWriteZoho?: () => void;
  /** Buttons of the host (asignar, cargar en viaje, cancelar…). */
  actions?: ReactNode;
  /** Drag handle rendered by the board when dragging is available. */
  handle?: ReactNode;
  dragging?: boolean;
}

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

/**
 * One delivery on the dispatch board: who it is for, when it has to be there,
 * what transport it has and how its Zoho mirror is doing. It never decides
 * anything: the host passes the actions the person may run.
 */
export function DeliveryCard({
  delivery,
  selected = false,
  onOpen,
  onWriteZoho,
  actions,
  handle,
  dragging = false,
}: DeliveryCardProps) {
  const window = formatWindow(delivery.windowStart, delivery.windowEnd);
  const title = delivery.customerName ?? delivery.caseNumber ?? 'Entrega';
  const reference = [delivery.salesOrderNumber ?? delivery.caseNumber, delivery.modeLabel]
    .filter(Boolean)
    .join(' · ');

  return (
    <article
      className={[
        'dispatch-card',
        selected ? 'dispatch-card-selected' : '',
        dragging ? 'dispatch-card-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="dispatch-card-head">
        {handle ?? null}
        <div className="dispatch-card-title">
          {onOpen ? (
            <button type="button" className="dispatch-card-name" onClick={onOpen}>
              {title}
            </button>
          ) : (
            <span className="dispatch-card-name">{title}</span>
          )}
          <span className="dispatch-card-sub">{reference}</span>
        </div>
        <Badge variant={BADGE_BY_TONE[delivery.tone]}>{delivery.statusLabel}</Badge>
      </div>

      <div className="dispatch-card-meta">
        {delivery.address.city ? (
          <span>
            <MapPin size={13} aria-hidden="true" /> {delivery.address.city}
          </span>
        ) : null}
        <span>
          <Clock size={13} aria-hidden="true" />{' '}
          {window ?? (delivery.plannedDate ? formatDayLabel(delivery.plannedDate) : 'Sin fecha')}
        </span>
        {delivery.lines.length > 0 ? (
          <span>
            <Package size={13} aria-hidden="true" /> {delivery.lines.length}{' '}
            {delivery.lines.length === 1 ? 'línea' : 'líneas'}
          </span>
        ) : null}
        {delivery.carrier || delivery.vehicleLabel ? (
          <span>
            <Truck size={13} aria-hidden="true" /> {delivery.carrier ?? delivery.vehicleLabel}
          </span>
        ) : null}
        {delivery.driverName ? (
          <span>
            <User size={13} aria-hidden="true" /> {delivery.driverName}
          </span>
        ) : null}
        {delivery.tripNumber ? <span>Viaje {delivery.tripNumber}</span> : null}
      </div>

      <div className="dispatch-card-actions">
        <ZohoSyncPill delivery={delivery} {...(onWriteZoho ? { onWrite: onWriteZoho } : {})} />
        {actions}
      </div>
    </article>
  );
}
