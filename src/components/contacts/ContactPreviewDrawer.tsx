'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ContactDetail } from '@/modules/contacts/contacts-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getContactStatusConfig,
} from '@/modules/contacts/contacts-helpers';

interface PreviewDrawerProps {
  contactId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
}

export function ContactPreviewDrawer({
  contactId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: PreviewDrawerProps) {
  const router = useRouter();
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => {
    setWatched(isWatched);
  }, [isWatched]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${basePath}/${contactId}/api`);
        if (!res.ok) throw new Error(`No pudimos cargar el ${entityLabel.toLowerCase()}.`);
        const json = (await res.json()) as ContactDetail & { is_watched?: boolean };
        if (!cancelled) {
          setContact(json);
          if (typeof json.is_watched === 'boolean') setWatched(json.is_watched);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [contactId, basePath, entityLabel]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', contactId);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
      toast.success(watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="so-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle de ${entityLabel.toLowerCase()}`}
      >
        <div className="so-detail-header">
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
              {contact?.contactName ?? 'Cargando...'}
            </h2>
            {contact?.companyName ? (
              <p
                style={{
                  color: 'var(--unik-text-muted)',
                  fontSize: '0.875rem',
                  margin: '4px 0 0',
                }}
              >
                {contact.companyName}
              </p>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {canWatch ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleWatch}
                aria-pressed={watched}
              >
                {watched ? <BellRing size={14} /> : <Bell size={14} />}
                {watched ? 'Siguiendo' : 'Seguir'}
              </button>
            ) : null}
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => router.push(`${basePath}/${contactId}`)}
            >
              <ExternalLink size={14} /> Abrir
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="so-detail-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <span className="spinner" /> Cargando...
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <p className="text-muted">{error}</p>
            </div>
          ) : contact ? (
            <>
              {/* Status + outstanding summary */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--unik-surface)',
                  borderRadius: 'var(--unik-radius-sm)',
                  border: '1px solid var(--unik-border-subtle)',
                  marginBottom: '1rem',
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--unik-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.02em',
                    }}
                  >
                    Estado
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className={`so-status-dot so-status-dot-${getContactStatusConfig(contact.status).tone}`} />
                    {getContactStatusConfig(contact.status).label}
                  </div>
                </div>
                {contact.outstandingReceivable && contact.outstandingReceivable !== '0' ? (
                  <div style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--unik-text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.02em',
                      }}
                    >
                      Saldo por cobrar
                    </div>
                    <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                      {formatCurrency(contact.outstandingReceivable, contact.currencyCode)}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Nombre" value={contact.contactName} />
                  <Field label="Empresa" value={contact.companyName} />
                  <Field label="Tipo" value={contact.contactType} />
                  <Field label="Moneda" value={contact.currencyCode} />
                  <Field label="Términos de pago" value={contact.paymentTermsLabel} />
                  <Field label="Idioma" value={contact.languageCode} />
                </div>
              </div>

              {/* Contact info */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Contacto</h3>
                <div className="so-detail-grid">
                  <Field label="Correo" value={contact.primaryEmail} />
                  <Field label="Teléfono" value={contact.primaryPhone} />
                  <Field label="Sitio web" value={contact.website} />
                </div>
              </div>

              {/* Fiscal (Mexico) */}
              {(contact.taxRegNo || contact.taxTreatment || contact.taxRegime || contact.legalName) ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Fiscal</h3>
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

              {/* Saldos */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Saldos</h3>
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

              {/* Sync info */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Última modificación remota" value={formatDateOnly(contact.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(contact.normalizedAt)} />
                </div>
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </>
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
