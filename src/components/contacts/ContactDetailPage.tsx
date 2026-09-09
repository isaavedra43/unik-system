'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing, Package, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import type { ContactDetail } from '@/modules/contacts/contacts-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getContactStatusConfig,
} from '@/modules/contacts/contacts-helpers';
import type { RelatedPackageSummary, RelatedInvoiceSummary } from '@/modules/cross-module/relationships-service';

interface ContactDetailPageProps {
  contact: ContactDetail;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  isWatched: boolean;
  canWatch: boolean;
  watchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  relatedPackages?: RelatedPackageSummary[];
  relatedInvoices?: RelatedInvoiceSummary[];
}

export function ContactDetailPage({
  contact,
  entityLabel,
  entityLabelPlural,
  basePath,
  isWatched: initialWatched,
  canWatch,
  watchAction,
  unwatchAction,
  relatedPackages,
  relatedInvoices,
}: ContactDetailPageProps) {
  const [watched, setWatched] = useState(initialWatched);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', contact.id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      toast.success(watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  return (
    <div className="app-content">
      <div
        className="page-header"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <Link
            href={basePath}
            style={{
              fontSize: '0.875rem',
              color: 'var(--unik-text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              marginBottom: '0.5rem',
            }}
          >
            <ArrowLeft size={14} /> {entityLabelPlural}
          </Link>
          <h1 className="page-title">{contact.contactName ?? entityLabel}</h1>
          <p className="page-description">{contact.companyName ?? '—'}</p>
        </div>
        {canWatch ? (
          <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
            {watched ? <BellRing size={14} /> : <Bell size={14} />}
            {watched ? 'Siguiendo' : 'Seguir'}
          </button>
        ) : null}
      </div>

      {/* Top summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <SummaryCard
          label="Estado"
          value={getContactStatusConfig(contact.status).label}
        />
        <SummaryCard
          label="Saldo por cobrar"
          value={formatCurrency(contact.outstandingReceivable, contact.currencyCode)}
        />
        <SummaryCard
          label="Saldo por pagar"
          value={formatCurrency(contact.outstandingPayable, contact.currencyCode)}
        />
        <SummaryCard label="Moneda" value={contact.currencyCode} />
      </div>

      {/* Two-column info */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1rem',
          alignItems: 'start',
        }}
      >
        <div className="card">
          <h2 className="card-title">General</h2>
          <div className="so-detail-grid">
            <Field label="Nombre" value={contact.contactName} />
            <Field label="Empresa" value={contact.companyName} />
            <Field label="Tipo" value={contact.contactType} />
            <Field label="Términos de pago" value={contact.paymentTermsLabel} />
            <Field label="Moneda" value={contact.currencyCode} />
            <Field label="Idioma" value={contact.languageCode} />
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Contacto</h2>
          <div className="so-detail-grid">
            <Field label="Correo" value={contact.primaryEmail} />
            <Field label="Teléfono" value={contact.primaryPhone} />
            <Field label="Sitio web" value={contact.website} />
          </div>
        </div>

        {/* Fiscal (Mexico) */}
        {(contact.taxRegNo || contact.taxTreatment || contact.taxRegime || contact.legalName) ? (
          <div className="card">
            <h2 className="card-title">Fiscal</h2>
            <div className="so-detail-grid">
              <Field label="RFC" value={contact.taxRegNo} />
              <Field label="Tratamiento fiscal" value={contact.taxTreatment} />
              <Field label="Régimen fiscal" value={contact.taxRegime} />
              <Field label="Razón social" value={contact.legalName} />
              <Field
                label="TDS registrado"
                value={contact.isTdsRegistered === true ? 'Sí' : contact.isTdsRegistered === false ? 'No' : null}
              />
            </div>
          </div>
        ) : null}

        <div className="card">
          <h2 className="card-title">Saldos</h2>
          <div className="so-detail-grid">
            <Field
              label="Por cobrar"
              value={formatCurrency(contact.outstandingReceivable, contact.currencyCode)}
            />
            <Field
              label="Por pagar"
              value={formatCurrency(contact.outstandingPayable, contact.currencyCode)}
            />
            <Field
              label="Créditos por cobrar"
              value={formatCurrency(contact.unusedCreditsReceivable, contact.currencyCode)}
            />
            <Field
              label="Créditos por pagar"
              value={formatCurrency(contact.unusedCreditsPayable, contact.currencyCode)}
            />
          </div>
        </div>
      </div>

      {/* Sync info */}
      <div className="card">
        <h2 className="card-title">Sincronización</h2>
        <div className="so-detail-grid">
          <Field label="Última modificación remota" value={formatDateOnly(contact.sourceRemoteModifiedAt)} />
          <Field label="Normalizado" value={formatDateTime(contact.normalizedAt)} />
          <Field label="Zoho ID" value={contact.zohoContactId} />
        </div>
      </div>

      {/* Cross-module relationships */}
      {(relatedPackages && relatedPackages.length > 0) || (relatedInvoices && relatedInvoices.length > 0) ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '1rem',
            alignItems: 'start',
          }}
        >
          {relatedPackages && relatedPackages.length > 0 ? (
            <div className="card">
              <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Package size={16} /> Paquetes relacionados
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {relatedPackages.map((pkg) => (
                  <Link
                    key={pkg.id}
                    href={`/app/packages/${pkg.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--unik-radius-sm)',
                      border: '1px solid var(--unik-border-subtle)',
                      background: 'var(--unik-surface)',
                      textDecoration: 'none',
                      color: 'inherit',
                      fontSize: '0.875rem',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{pkg.packageNumber ?? '—'}</span>
                    <span style={{ color: 'var(--unik-text-muted)', fontSize: '0.75rem' }}>
                      {pkg.status ?? '—'} · {pkg.date ? formatDateOnly(pkg.date) : '—'}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {relatedInvoices && relatedInvoices.length > 0 ? (
            <div className="card">
              <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={16} /> Facturas relacionadas
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {relatedInvoices.map((inv) => (
                  <Link
                    key={inv.id}
                    href={`/app/invoices/${inv.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--unik-radius-sm)',
                      border: '1px solid var(--unik-border-subtle)',
                      background: 'var(--unik-surface)',
                      textDecoration: 'none',
                      color: 'inherit',
                      fontSize: '0.875rem',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{inv.invoiceNumber ?? '—'}</span>
                    <span style={{ color: 'var(--unik-text-muted)', fontSize: '0.75rem' }}>
                      {inv.status ?? '—'} · {formatCurrency(inv.total, inv.currencyCode)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  highlighted,
}: {
  label: string;
  value: string | null;
  highlighted?: boolean;
}) {
  return (
    <div className="so-detail-field">
      <span className="so-detail-field-label">{label}</span>
      <span className="so-detail-field-value" style={highlighted ? { fontWeight: 700 } : undefined}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div
      style={{
        padding: '0.75rem 1rem',
        background: 'var(--unik-surface)',
        borderRadius: 'var(--unik-radius-sm)',
        border: '1px solid var(--unik-border-subtle)',
      }}
    >
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--unik-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '1rem', fontWeight: 600 }}>{value ?? '—'}</div>
    </div>
  );
}
