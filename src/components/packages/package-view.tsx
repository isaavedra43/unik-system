'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  MapPin,
  Package as PackageIcon,
  RefreshCw,
  Truck,
} from 'lucide-react';
import type { PackageDetail } from '@/modules/packages/packages-contract';
import {
  formatDateOnly,
  formatDateTime,
  formatNumber,
  getPackageStatusConfig,
} from '@/modules/packages/packages-helpers';
import { cn } from '@/lib/utils';

/** Building blocks shared by the package detail page and the preview drawer. */

export function PackageStatusBadge({
  status,
  className,
}: {
  status: string | null;
  className?: string;
}) {
  const config = getPackageStatusConfig(status);
  const badge =
    config.tone === 'success'
      ? 'badge-success'
      : config.tone === 'danger'
        ? 'badge-danger'
        : config.tone === 'warning'
          ? 'badge-warning'
          : config.tone === 'info'
            ? 'badge-info'
            : 'badge-weak';
  return (
    <span className={cn('badge', badge, className)}>
      <span className="pkg-dot" aria-hidden="true" />
      {config.label}
    </span>
  );
}

type StepState = 'done' | 'current' | 'pending';

function stepStates(pkg: PackageDetail): StepState[] {
  const status = (pkg.status ?? '').toLowerCase();
  if (status === 'delivered' || status === 'fulfilled') return ['done', 'done', 'done'];
  if (status === 'shipped' || status === 'partially_shipped' || pkg.shipmentDate)
    return ['done', 'current', 'pending'];
  return ['current', 'pending', 'pending'];
}

export function PackageSteps({ pkg, compact }: { pkg: PackageDetail; compact?: boolean }) {
  const states = stepStates(pkg);
  const steps = [
    { label: 'Empaquetado', date: pkg.date },
    { label: 'Enviado', date: pkg.shipmentDate, meta: pkg.carrier },
    { label: 'Entregado', date: pkg.deliveryDate },
  ];
  const returned = (pkg.status ?? '').toLowerCase() === 'returned';
  return (
    <ol
      className={cn('pkg-steps', compact && 'is-compact', returned && 'is-returned')}
      aria-label="Avance del paquete"
    >
      {steps.map((step, i) => (
        <li key={step.label} className={`pkg-step is-${states[i]}`}>
          <span className="pkg-step-marker" aria-hidden="true">
            {states[i] === 'done' ? <Check size={12} /> : null}
          </span>
          <span className="pkg-step-text">
            <strong>{step.label}</strong>
            <span>
              {step.date ? formatDateOnly(step.date) : states[i] === 'pending' ? 'Pendiente' : '—'}
              {step.meta && !compact ? ` · ${step.meta}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PackagePdfActions({
  pkgId,
  basePath,
  size = 'sm',
}: {
  pkgId: string;
  basePath: string;
  size?: 'sm' | 'md';
}) {
  const href = `${basePath}/${pkgId}/pdf`;
  return (
    <div className="pkg-pdf-actions">
      <a
        className={`btn btn-secondary btn-${size}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        <FileText size={14} aria-hidden="true" /> PDF de Zoho
      </a>
      <a
        className={`btn btn-secondary btn-${size} pkg-icon-only`}
        href={`${href}?download=1`}
        aria-label="Descargar PDF"
        title="Descargar PDF"
      >
        <Download size={14} aria-hidden="true" />
      </a>
    </div>
  );
}

export function PackageShipmentFacts({ pkg }: { pkg: PackageDetail }) {
  const shipped = Boolean(pkg.shipmentDate || pkg.shipmentNumber || pkg.carrier);
  return (
    <div className="pkg-ship">
      <div className={cn('pkg-carrier', !pkg.carrier && 'is-empty')}>
        <span className="pkg-carrier-icon" aria-hidden="true">
          <Truck size={18} />
        </span>
        <span>
          <span className="pkg-label">Transportista</span>
          <strong>
            {pkg.carrier ?? (shipped ? 'Sin transportista asignado' : 'Aún no se envía')}
          </strong>
        </span>
      </div>
      <dl className="pkg-facts">
        <Fact label="Orden de envío" value={pkg.shipmentNumber} mono />
        <Fact
          label="Fecha de envío"
          value={pkg.shipmentDate ? formatDateOnly(pkg.shipmentDate) : null}
        />
        <Fact
          label="Entregado el"
          value={pkg.deliveryDate ? formatDateOnly(pkg.deliveryDate) : null}
        />
        <Fact
          label="Guía"
          value={
            pkg.trackingNumber ? (
              pkg.trackingUrl ? (
                <a
                  href={pkg.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pkg-link"
                >
                  {pkg.trackingNumber}
                </a>
              ) : (
                <span className="pkg-mono">{pkg.trackingNumber}</span>
              )
            ) : null
          }
        />
        <Fact label="Método de entrega" value={pkg.deliveryMethod} />
        <Fact label="Tipo de envío" value={pkg.shipmentType} />
      </dl>
      {pkg.notes ? <p className="pkg-notes">{pkg.notes}</p> : null}
    </div>
  );
}

export function PackageAddress({ pkg }: { pkg: PackageDetail }) {
  const cityLine = [pkg.shippingCity, pkg.shippingState, pkg.shippingZip]
    .filter(Boolean)
    .join(', ');
  const hasAddress = Boolean(
    pkg.shippingAddress || cityLine || pkg.shippingCountry || pkg.shippingAttention
  );
  if (!hasAddress) {
    return (
      <p className="pkg-empty-line">
        <MapPin size={14} aria-hidden="true" /> Zoho no envió la dirección de este paquete todavía.
      </p>
    );
  }
  return (
    <address className="pkg-address">
      {pkg.shippingAttention ? <strong>{pkg.shippingAttention}</strong> : null}
      {pkg.shippingAddress ? <span>{pkg.shippingAddress}</span> : null}
      {cityLine ? <span>{cityLine}</span> : null}
      {pkg.shippingCountry ? <span>{pkg.shippingCountry}</span> : null}
      {pkg.shippingPhone ? <span className="pkg-mono">{pkg.shippingPhone}</span> : null}
    </address>
  );
}

export function PackageItemsTable({ pkg, compact }: { pkg: PackageDetail; compact?: boolean }) {
  if (pkg.items.length === 0) {
    return (
      <div className="pkg-empty">
        <span className="pkg-empty-icon" aria-hidden="true">
          <PackageIcon size={18} />
        </span>
        <p>
          Zoho aún no entregó el contenido de este paquete. Se completa en la siguiente
          sincronización; el PDF de Zoho ya lo incluye.
        </p>
      </div>
    );
  }
  const total = pkg.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
  const units = new Set(pkg.items.map((i) => i.unit).filter(Boolean));
  const unitLabel = units.size === 1 ? [...units][0] : '';
  return (
    <div className="table-wrap">
      <table className={cn('table pkg-items', compact && 'so-table-compact')}>
        <thead>
          <tr>
            <th scope="col" className="pkg-col-index">
              #
            </th>
            <th scope="col">Artículo</th>
            <th scope="col">Código</th>
            <th scope="col" className="is-right">
              Cantidad
            </th>
          </tr>
        </thead>
        <tbody>
          {pkg.items.map((item, index) => (
            <tr key={item.id}>
              <td className="pkg-col-index text-muted">{index + 1}</td>
              <td>
                <div className="pkg-item-name">{item.name ?? '—'}</div>
                {item.description ? <div className="pkg-item-desc">{item.description}</div> : null}
              </td>
              <td className="pkg-mono text-muted">{item.sku ?? '—'}</td>
              <td className="is-right pkg-mono">
                {formatNumber(item.quantity)}
                {item.unit ? <span className="pkg-unit"> {item.unit}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Cantidad total</td>
            <td className="is-right pkg-mono">
              {formatNumber(total)}
              {unitLabel ? <span className="pkg-unit"> {unitLabel}</span> : null}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="pkg-fact">
      <dt>{label}</dt>
      <dd className={cn(mono && 'pkg-mono', empty && 'is-empty')}>{empty ? '—' : value}</dd>
    </div>
  );
}

export function RelatedLink({
  href,
  title,
  meta,
}: {
  href: string;
  title: string;
  meta?: string | null;
}) {
  return (
    <Link href={href} className="pkg-related">
      <span className="pkg-related-title">{title}</span>
      {meta ? <span className="pkg-related-meta">{meta}</span> : null}
    </Link>
  );
}

/**
 * "Actualizar desde Zoho" plus the outcome of the automatic refresh done when
 * the package was opened, so the user always knows how current the data is.
 */
export function PackageZohoRefresh({
  pkg,
  basePath,
  onRefreshed,
  size = 'sm',
}: {
  pkg: PackageDetail;
  basePath: string;
  onRefreshed: (pkg: PackageDetail) => void;
  size?: 'sm' | 'md';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/${pkg.id}/refresh`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as
        (PackageDetail & { error?: string }) | null;
      if (!res.ok || !json) {
        setError(json?.error ?? 'No se pudo consultar Zoho');
        return;
      }
      if (json.zohoRefresh?.status === 'failed')
        setError(json.zohoRefresh.error ?? 'Zoho no respondió');
      onRefreshed(json);
    } catch {
      setError('Error de red');
    } finally {
      setBusy(false);
    }
  }

  const outcome = pkg.zohoRefresh;
  const note =
    error ??
    (outcome?.status === 'failed'
      ? `Mostrando datos guardados: ${outcome.error ?? 'Zoho no respondió'}`
      : outcome?.status === 'busy'
        ? 'Zoho está ocupado; mostrando datos guardados.'
        : null);
  const checkedAt =
    outcome?.status === 'refreshed'
      ? 'Verificado con Zoho hace un momento'
      : pkg.lastDetailFetchedAt
        ? `Verificado con Zoho ${formatDateTime(pkg.lastDetailFetchedAt)}`
        : 'Aún no verificado con Zoho';

  return (
    <div className="pkg-refresh">
      <button
        type="button"
        className={`btn btn-secondary btn-${size}`}
        onClick={refresh}
        disabled={busy}
        title="Vuelve a leer este paquete en Zoho"
      >
        {busy ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <RefreshCw size={14} aria-hidden="true" />
        )}
        Actualizar desde Zoho
      </button>
      <span
        className={cn('pkg-refresh-note', note && 'is-warning')}
        role={note ? 'status' : undefined}
      >
        {note ? <AlertTriangle size={12} aria-hidden="true" /> : null}
        {note ?? checkedAt}
      </span>
    </div>
  );
}
