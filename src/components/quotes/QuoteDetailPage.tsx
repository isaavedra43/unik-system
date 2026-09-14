'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ArrowLeft, Bell, BellRing, Check, Copy, FileDown, Mail, Pencil, RefreshCw, Send, User, X, History,
} from 'lucide-react';
import { toast } from 'sonner';
import type { QuoteDetail, QuoteChangeEventRow } from '@/modules/quotes/quotes-contract';
import {
  formatCurrency, formatDateOnly, formatDateTime, formatNumber, getQuoteStatusConfig, getQuoteExpiryInfo,
  isQuoteEditable, canMarkSent, canDecide,
} from '@/modules/quotes/quotes-helpers';
import { QUOTE_CHANGE_FIELD_LABELS } from '@/modules/quotes/quotes-change-labels';
import type { RelatedContactSummary } from '@/modules/cross-module/relationships-service';
import type { QuoteWriteResult } from '@/app/app/quotes/actions';
import type { QuoteEmailInput } from '@/modules/quotes/quotes-form-schema';

type WatchState = { error: string | null; success: boolean; isWatched: boolean };

interface QuoteDetailPageProps {
  quote: QuoteDetail;
  changeEvents: QuoteChangeEventRow[];
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  isWatched: boolean;
  canWatch: boolean;
  canEdit: boolean;
  canCreate: boolean;
  canChangeStatus: boolean;
  canSendEmail: boolean;
  isMockMode: boolean;
  relatedContact?: RelatedContactSummary | null;
  customerEmail?: string | null;
  watchAction: (prevState: WatchState, formData: FormData) => Promise<WatchState>;
  unwatchAction: (prevState: WatchState, formData: FormData) => Promise<WatchState>;
  changeStatusAction: (quoteId: string, action: string) => Promise<QuoteWriteResult>;
  emailAction: (quoteId: string, input: QuoteEmailInput) => Promise<QuoteWriteResult>;
  cloneAction: (quoteId: string, requestKey: string) => Promise<QuoteWriteResult>;
  refreshAction: (quoteId: string) => Promise<QuoteWriteResult>;
}

function toneClasses(tone: string): { pill: string; dot: string } {
  switch (tone) {
    case 'success': return { pill: 'bg-success/10 text-success', dot: 'bg-success' };
    case 'danger': return { pill: 'bg-destructive/10 text-destructive', dot: 'bg-destructive' };
    case 'warning': return { pill: 'bg-warning/10 text-warning', dot: 'bg-warning' };
    case 'info': return { pill: 'bg-info/10 text-info', dot: 'bg-info' };
    default: return { pill: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' };
  }
}

export function QuoteDetailPage({
  quote: initialQuote, changeEvents: initialEvents, entityLabel, entityLabelPlural, basePath,
  isWatched: initialWatched, canWatch, canEdit, canCreate, canChangeStatus, canSendEmail, isMockMode,
  relatedContact, customerEmail,
  watchAction, unwatchAction, changeStatusAction, emailAction, cloneAction, refreshAction,
}: QuoteDetailPageProps) {
  const router = useRouter();
  const [quote, setQuote] = useState(initialQuote);
  const [events] = useState(initialEvents);
  const [watched, setWatched] = useState(initialWatched);
  const [pending, startTransition] = useTransition();
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState(customerEmail ?? '');
  const [emailCc, setEmailCc] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [confirmAction, setConfirmAction] = useState<'sent' | 'accepted' | 'declined' | null>(null);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', quote.id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      toast.success(watched ? `Dejaste de seguir la ${entityLabel.toLowerCase()}` : `${entityLabel} seguida`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const applyResult = (result: QuoteWriteResult, successMessage: string) => {
    if (result.success && result.quote) {
      setQuote(result.quote);
      toast.success(successMessage);
      router.refresh();
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const runStatus = (action: 'sent' | 'accepted' | 'declined') => {
    setConfirmAction(null);
    startTransition(async () => {
      const labels = { sent: 'marcada como enviada', accepted: 'marcada como aceptada', declined: 'marcada como rechazada' };
      applyResult(await changeStatusAction(quote.id, action), `Cotización ${labels[action]} en Zoho`);
    });
  };

  const runRefresh = () => {
    startTransition(async () => {
      applyResult(await refreshAction(quote.id), 'Cotización actualizada desde Zoho');
    });
  };

  const runClone = () => {
    startTransition(async () => {
      const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      const result = await cloneAction(quote.id, key);
      if (result.success && result.quote) {
        toast.success(`Copia creada: ${result.quote.estimateNumber ?? ''}`);
        router.push(`${basePath}/${result.quote.id}`);
      } else {
        toast.error(result.error ?? 'No se pudo duplicar');
      }
    });
  };

  const submitEmail = () => {
    const to = emailTo.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const cc = emailCc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) { toast.error('Agrega al menos un destinatario'); return; }
    startTransition(async () => {
      const result = await emailAction(quote.id, { to, cc, subject: emailSubject || null, body: emailBody || null });
      if (result.success) setEmailOpen(false);
      applyResult(result, 'Cotización enviada por correo desde Zoho');
    });
  };

  const statusConfig = getQuoteStatusConfig(quote.status);
  const statusTone = toneClasses(statusConfig.tone);
  const expiry = getQuoteExpiryInfo(quote.expiryDate, quote.status);
  const editable = isQuoteEditable(quote.status);
  const hasBilling = Boolean(quote.billingAddress || quote.billingCity || quote.billingState || quote.billingCountry);
  const hasShipping = Boolean(quote.shippingAddress || quote.shippingCity || quote.shippingState || quote.shippingCountry);

  return (
    <div className="app-content">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Link href={basePath} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> Volver a {entityLabelPlural.toLowerCase()}
          </Link>
          <div className="flex items-center gap-2 flex-wrap">
            {canWatch && (
              <button onClick={handleWatch} className="btn btn-secondary btn-sm">
                {watched ? <><BellRing size={14} className="text-primary" />Siguiendo</> : <><Bell size={14} />Seguir</>}
              </button>
            )}
            <button onClick={runRefresh} disabled={pending || isMockMode} className="btn btn-secondary btn-sm" title={isMockMode ? 'No disponible en modo simulación' : 'Traer la última versión desde Zoho'}>
              <RefreshCw size={14} className={pending ? 'spin' : ''} /> Actualizar desde Zoho
            </button>
            <a href={`${basePath}/${quote.id}/pdf`} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm" title="PDF oficial generado por Zoho Books">
              <FileDown size={14} /> PDF de Zoho
            </a>
            {canCreate && (
              <button onClick={runClone} disabled={pending} className="btn btn-secondary btn-sm" title="Crear una nueva cotización con los mismos conceptos">
                <Copy size={14} /> Duplicar
              </button>
            )}
            {canEdit && editable && (
              <Link href={`${basePath}/${quote.id}/edit`} className="btn btn-primary btn-sm">
                <Pencil size={14} /> Editar
              </Link>
            )}
          </div>
        </div>

        {isMockMode ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            Modo simulación activo (ZOHO_BOOKS_MOCK=true): las acciones no llegan a Zoho y el PDF oficial no está disponible.
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{quote.estimateNumber ?? '—'}</h1>
              {quote.customerName && <p className="text-sm text-muted-foreground">Cliente: {quote.customerName}</p>}
              <p className="text-xs text-muted-foreground">{quote.createdInUnik ? 'Creada desde UNIK' : 'Creada en Zoho Books'}{quote.lastEditedInUnikAt ? ` · editada en UNIK ${formatDateTime(quote.lastEditedInUnikAt)}` : ''}</p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone.pill}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusTone.dot}`} />
                {statusConfig.label}
              </span>
              {expiry ? (
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses(expiry.tone).pill}`}>{expiry.label}</span>
              ) : null}
            </div>
          </div>

          {canChangeStatus || canSendEmail ? (
            <div className="flex items-center gap-2 flex-wrap border-t pt-4">
              {canChangeStatus && canMarkSent(quote.status) && (
                <button onClick={() => setConfirmAction('sent')} disabled={pending} className="btn btn-secondary btn-sm"><Send size={14} /> Marcar como enviada</button>
              )}
              {canChangeStatus && canDecide(quote.status) && (
                <>
                  <button onClick={() => setConfirmAction('accepted')} disabled={pending} className="btn btn-secondary btn-sm"><Check size={14} /> Marcar aceptada</button>
                  <button onClick={() => setConfirmAction('declined')} disabled={pending} className="btn btn-secondary btn-sm"><X size={14} /> Marcar rechazada</button>
                </>
              )}
              {canSendEmail && (
                <button onClick={() => setEmailOpen(true)} disabled={pending} className="btn btn-secondary btn-sm"><Mail size={14} /> Enviar por correo (Zoho)</button>
              )}
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Fecha" value={formatDateOnly(quote.date)} />
          <DetailCard label="Vence" value={formatDateOnly(quote.expiryDate)} />
          <DetailCard label="Vendedor" value={quote.salespersonName ?? '—'} />
          <DetailCard label="Referencia" value={quote.referenceNumber ?? '—'} />
          <DetailCard label="Moneda" value={quote.currencyCode ?? '—'} />
          <DetailCard label="Plantilla PDF" value={quote.templateName ?? '—'} />
          <DetailCard label="Subtotal" value={formatCurrency(quote.subTotal, quote.currencyCode)} />
          <DetailCard label="Descuento" value={formatCurrency(quote.discountTotal ?? quote.discount, quote.currencyCode)} />
          <DetailCard label="Impuestos" value={formatCurrency(quote.taxTotal, quote.currencyCode)} />
          <DetailCard label="Envío" value={formatCurrency(quote.shippingCharge, quote.currencyCode)} />
          <DetailCard label="Ajuste" value={formatCurrency(quote.adjustment, quote.currencyCode)} />
          <DetailCard label="Total" value={formatCurrency(quote.total, quote.currencyCode)} />
          {quote.acceptedDate && <DetailCard label="Aceptada el" value={formatDateOnly(quote.acceptedDate)} />}
          {quote.declinedDate && <DetailCard label="Rechazada el" value={formatDateOnly(quote.declinedDate)} />}
        </div>

        {hasBilling ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Dirección de facturación</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailCard label="Calle" value={[quote.billingAddress, quote.billingStreet2].filter(Boolean).join(', ') || '—'} />
              <DetailCard label="Ciudad" value={quote.billingCity ?? '—'} />
              <DetailCard label="Estado" value={quote.billingState ?? '—'} />
              <DetailCard label="C.P." value={quote.billingZip ?? '—'} />
              <DetailCard label="País" value={quote.billingCountry ?? '—'} />
            </div>
          </div>
        ) : null}

        {hasShipping ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Dirección de envío</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailCard label="Calle" value={[quote.shippingAddress, quote.shippingStreet2].filter(Boolean).join(', ') || '—'} />
              <DetailCard label="Ciudad" value={quote.shippingCity ?? '—'} />
              <DetailCard label="Estado" value={quote.shippingState ?? '—'} />
              <DetailCard label="C.P." value={quote.shippingZip ?? '—'} />
              <DetailCard label="País" value={quote.shippingCountry ?? '—'} />
            </div>
          </div>
        ) : null}

        {quote.items.length > 0 && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Conceptos</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Producto</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Descripción</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Cantidad</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Precio</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Desc.</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Impuesto</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.items.map((item) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <div>{item.name ?? '—'}</div>
                        {item.sku ? <div className="text-xs text-muted-foreground">SKU {item.sku}</div> : null}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{item.description ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{formatNumber(item.quantity)} {item.unit ?? ''}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(item.rate, quote.currencyCode)}</td>
                      <td className="px-3 py-2 text-right">{item.discount && Number(String(item.discount).replace('%', '')) > 0 ? String(item.discount) : '—'}</td>
                      <td className="px-3 py-2 text-right">{item.taxName ? (item.taxName.includes('%') ? item.taxName : `${item.taxName} (${formatNumber(item.taxPercentage)}%)`) : '—'}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(item.lineTotal, quote.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(quote.notes || quote.terms) ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Notas y términos</h2>
            {quote.notes && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Notas</p>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{quote.notes}</p>
              </div>
            )}
            {quote.terms && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Términos</p>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{quote.terms}</p>
              </div>
            )}
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2"><History className="h-4 w-4" /> Historial de cambios</h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin cambios registrados desde la primera sincronización.</p>
          ) : (
            <ul className="space-y-3">
              {events.map((event) => <ChangeEventItem key={event.id} event={event} />)}
            </ul>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación en Zoho" value={formatDateTime(quote.zohoLastModifiedTime ?? quote.sourceRemoteModifiedAt)} />
            <DetailCard label="Última normalización" value={formatDateTime(quote.normalizedAt)} />
            <DetailCard label="ID Zoho" value={quote.zohoEstimateId} />
            <DetailCard label="ID Snapshot" value={quote.sourceSnapshotId} />
          </div>
        </div>

        {relatedContact && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><User className="h-4 w-4" /> Contacto relacionado</h2>
            <Link href={`/app/contacts/customers/${relatedContact.id}`} className="inline-flex items-center justify-between w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm hover:bg-accent transition-colors">
              <span className="font-medium">{relatedContact.contactName ?? relatedContact.companyName ?? '—'}</span>
              <span className="text-muted-foreground text-xs">{relatedContact.contactType ?? '—'}</span>
            </Link>
          </div>
        )}
      </div>

      {confirmAction ? (
        <>
          <div className="overlay" onClick={() => setConfirmAction(null)} aria-hidden="true" />
          <div className="modal-panel" style={{ padding: "1.5rem" }} role="dialog" aria-modal="true" aria-label="Confirmar cambio de estado">
            <h3 style={{ marginTop: 0 }}>Confirmar en Zoho</h3>
            <p className="text-sm text-muted-foreground">
              {confirmAction === 'sent' && 'La cotización pasará a estado "Enviada" en Zoho Books. Después de esto ya no podrá volver a borrador.'}
              {confirmAction === 'accepted' && 'La cotización se marcará como "Aceptada" en Zoho Books. Zoho no permite editar cotizaciones aceptadas.'}
              {confirmAction === 'declined' && 'La cotización se marcará como "Rechazada" en Zoho Books.'}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirmAction(null)}>Cancelar</button>
              <button className="btn btn-primary btn-sm" onClick={() => runStatus(confirmAction)} disabled={pending}>Confirmar</button>
            </div>
          </div>
        </>
      ) : null}

      {emailOpen ? (
        <>
          <div className="overlay" onClick={() => setEmailOpen(false)} aria-hidden="true" />
          <div className="modal-panel" style={{ padding: "1.5rem" }} role="dialog" aria-modal="true" aria-label="Enviar cotización por correo">
            <h3 style={{ marginTop: 0 }}>Enviar por correo desde Zoho</h3>
            <p className="text-sm text-muted-foreground" style={{ marginBottom: '1rem' }}>
              Zoho enviará el correo con su plantilla y el PDF oficial adjunto. Si está en borrador pasará a &quot;Enviada&quot;.
            </p>
            <div className="space-y-3">
              <label className="form-field">
                <span className="form-label">Para (separa con comas)</span>
                <input className="input" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="cliente@empresa.com" />
              </label>
              <label className="form-field">
                <span className="form-label">CC</span>
                <input className="input" value={emailCc} onChange={(e) => setEmailCc(e.target.value)} placeholder="opcional" />
              </label>
              <label className="form-field">
                <span className="form-label">Asunto</span>
                <input className="input" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder="Vacío = asunto por defecto de Zoho" />
              </label>
              <label className="form-field">
                <span className="form-label">Mensaje</span>
                <textarea className="input" rows={4} value={emailBody} onChange={(e) => setEmailBody(e.target.value)} placeholder="Vacío = plantilla de Zoho" />
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setEmailOpen(false)}>Cancelar</button>
              <button className="btn btn-primary btn-sm" onClick={submitEmail} disabled={pending}><Mail size={14} /> Enviar</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ChangeEventItem({ event }: { event: QuoteChangeEventRow }) {
  const changes = (event.changes ?? {}) as { fields?: Record<string, { before: unknown; after: unknown }>; items?: { added?: string[]; removed?: string[]; modified?: Record<string, unknown> }; origin?: string };
  const fields = changes.fields ?? {};
  const items = changes.items;
  const originLabel: Record<string, string> = {
    created_in_unik: 'Creada en UNIK', edited_in_unik: 'Editada en UNIK', status_sent: 'Marcada enviada', status_accepted: 'Marcada aceptada',
    status_declined: 'Marcada rechazada', emailed: 'Enviada por correo', refreshed: 'Actualizada desde Zoho', refreshed_conflict: 'Cambio detectado en Zoho',
  };
  return (
    <li className="text-sm border-l-2 border-muted pl-3 space-y-1">
      <div className="text-xs text-muted-foreground">
        {formatDateTime(event.createdAt)}{changes.origin ? ` · ${originLabel[changes.origin] ?? changes.origin}` : ' · Detectado por sincronización'}
      </div>
      {Object.entries(fields).map(([field, change]) => (
        <div key={field}>
          <span className="font-medium">{QUOTE_CHANGE_FIELD_LABELS[field] ?? field}:</span>{' '}
          <span className="text-muted-foreground">{String(change.before ?? '—')}</span> → <span>{String(change.after ?? '—')}</span>
        </div>
      ))}
      {items?.added && items.added.length > 0 ? <div>Conceptos agregados: {items.added.join(', ')}</div> : null}
      {items?.removed && items.removed.length > 0 ? <div>Conceptos eliminados: {items.removed.join(', ')}</div> : null}
      {items?.modified && Object.keys(items.modified).length > 0 ? <div>Conceptos modificados: {Object.keys(items.modified).join(', ')}</div> : null}
    </li>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  );
}
