'use client';

import { CloudUpload, RefreshCw } from 'lucide-react';
import { zohoPill, type DispatchDelivery } from '@/modules/areas/logistica/logistics-view-model';

export interface ZohoSyncPillProps {
  delivery: Pick<DispatchDelivery, 'status' | 'zohoSyncState' | 'zohoError' | 'mode'>;
  /** Offered when the delivery needs somebody to (re)write the shipment order. */
  onWrite?: () => void;
  disabled?: boolean;
}

/**
 * State of the Zoho mirror of a delivery (plan 7.6). Zoho is the authority of
 * the package: when it answered with different values the pill becomes the
 * "Escribir en Zoho" button, and while UNIK is writing it only informs.
 *
 * It renders nothing when the delivery has no Zoho shipment to keep in sync, so
 * a pickup or a direct-supplier delivery never shows a state that is not real.
 */
export function ZohoSyncPill({ delivery, onWrite, disabled = false }: ZohoSyncPillProps) {
  const pill = zohoPill(delivery);
  if (!pill) return null;
  const className = `zoho-pill zoho-pill-${pill.tone}`;

  if (pill.actionable && onWrite) {
    return (
      <button
        type="button"
        className={className}
        onClick={onWrite}
        disabled={disabled}
        title={pill.detail}
        aria-label={`${pill.actionLabel}: ${pill.detail}`}
      >
        <CloudUpload size={13} aria-hidden="true" />
        {pill.actionLabel}
      </button>
    );
  }

  return (
    <span className={className} title={pill.detail}>
      {pill.tone === 'warning' ? <RefreshCw size={13} aria-hidden="true" /> : null}
      {pill.label}
      <span className="sr-only">. {pill.detail}</span>
    </span>
  );
}
