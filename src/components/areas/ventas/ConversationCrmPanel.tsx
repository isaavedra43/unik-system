'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import '@/styles/operations/ventas.css';
import { describeSubmitOutcome, formatDueLabel } from '@/components/operations/mywork-model';
import { Badge, Button } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { ConversationCrmPanel as ConversationCrmPanelDTO } from '@/modules/crm/crm-queries';
import {
  formatMoney,
  opportunityHref,
  quoteHref,
  salesOrderHref,
  VENTAS_API,
  ventasRadarHref,
} from '@/modules/areas/ventas/ventas-constants';
import { buildCreateFromConversationCommand } from './pipeline-model';

/**
 * Panel CRM de una conversación de la bandeja (plan 6.6 y 7.6): la oportunidad
 * viva del cliente con su etapa, valor y siguiente acción, sus cotizaciones y
 * órdenes recientes, las señales del radar y el botón para crear la oportunidad
 * cuando todavía no existe.
 *
 * Es aditivo: si la persona no tiene CRM (o la consulta falla) el panel no se
 * muestra y la bandeja sigue funcionando igual.
 */

export interface ConversationCrmPanelProps {
  conversationId: string;
  userId: string;
}

/**
 * Sólo la lectura. La cola offline vive en el cuerpo, que únicamente se monta
 * cuando el panel existe: una persona de soporte sin CRM recibía 403 y, aun
 * así, abría IndexedDB y un temporizador de sincronización de 30 s que no usaba.
 */
export function ConversationCrmPanel({ conversationId, userId }: ConversationCrmPanelProps) {
  const [panel, setPanel] = useState<ConversationCrmPanelDTO | null>(null);
  const [hidden, setHidden] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(VENTAS_API.conversation(conversationId));
      if (!response.ok) {
        // 403 (sin CRM) o 404 (cuenta ajena): el panel simplemente no aparece.
        setHidden(true);
        return;
      }
      const json = (await response.json().catch(() => ({}))) as {
        panel?: ConversationCrmPanelDTO;
      };
      if (!json.panel) {
        setHidden(true);
        return;
      }
      setPanel(json.panel);
      setHidden(false);
    } catch {
      setHidden(true);
    }
  }, [conversationId]);

  useEffect(() => {
    setPanel(null);
    setHidden(false);
    void load();
  }, [load, reloadToken]);

  if (hidden || !panel) return null;

  return (
    <ConversationCrmPanelBody
      panel={panel}
      conversationId={conversationId}
      userId={userId}
      onCreated={() => setReloadToken((value) => value + 1)}
    />
  );
}

interface ConversationCrmPanelBodyProps {
  panel: ConversationCrmPanelDTO;
  conversationId: string;
  userId: string;
  onCreated: () => void;
}

function ConversationCrmPanelBody({
  panel,
  conversationId,
  userId,
  onCreated,
}: ConversationCrmPanelBodyProps) {
  const { submit } = useOfflineCommandQueue(userId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const live = panel.opportunities.find(
    (opportunity) => opportunity.status === 'open' || opportunity.status === 'dormant'
  );
  const now = new Date();
  const due = live?.nextActionAt ? formatDueLabel(live.nextActionAt, now) : null;

  async function createOpportunity() {
    setBusy(true);
    try {
      const outcome = await submit<Record<string, unknown>>(
        buildCreateFromConversationCommand({ conversationId })
      );
      const feedback = describeSubmitOutcome(outcome, 'Oportunidad creada');
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      if (feedback.kind === 'success') onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ventas-inbox-panel" aria-label="CRM de la conversación">
      <div className="ventas-inbox-head">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="ventas-inbox-body"
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          CRM
        </button>

        {live ? (
          <>
            <Link href={opportunityHref(live.id)}>
              <strong>{live.number}</strong>
            </Link>
            <Badge variant="info">{live.stageName ?? 'Sin etapa'}</Badge>
            <span>{formatMoney(live.estimatedValue, live.currency)}</span>
            {due ? (
              <span
                className={
                  due.tone === 'danger'
                    ? 'ventas-card-due-danger'
                    : due.tone === 'warning'
                      ? 'ventas-card-due-warning'
                      : undefined
                }
                title={due.title}
              >
                {live.nextActionText ? `${live.nextActionText} · ${due.label}` : due.label}
              </span>
            ) : (
              <span className="ventas-muted">Sin siguiente acción</span>
            )}
          </>
        ) : (
          <span className="ventas-muted">Esta conversación todavía no tiene oportunidad</span>
        )}

        <div className="ventas-toolbar-spacer" />

        {panel.permissions.canCreateOpportunity ? (
          <Button variant="secondary" size="sm" onClick={createOpportunity} disabled={busy}>
            <Plus size={14} aria-hidden="true" />
            {busy ? 'Creando…' : 'Crear oportunidad'}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="ventas-inbox-body" id="ventas-inbox-body">
          <div className="ventas-inbox-grid">
            <div className="ventas-field">
              <span className="ventas-field-label">Cliente</span>
              <span>{panel.customer?.name ?? panel.contact.displayName}</span>
              {panel.customer?.paymentTermsLabel ? (
                <span className="ventas-muted">{panel.customer.paymentTermsLabel}</span>
              ) : null}
            </div>
            <div className="ventas-field">
              <span className="ventas-field-label">Atiende</span>
              <span>{panel.conversation.assignedToName ?? 'Sin asignar'}</span>
            </div>
            <div className="ventas-field">
              <span className="ventas-field-label">Oportunidades</span>
              <span>{panel.opportunities.length}</span>
            </div>
          </div>

          {panel.quotes.length > 0 ? (
            <ul className="ventas-list">
              {panel.quotes.map((quote) => (
                <li key={quote.id} className="ventas-list-item">
                  <Link href={quoteHref(quote.id)}>
                    <strong>{quote.estimateNumber ?? quote.zohoEstimateId}</strong>
                  </Link>
                  <span>{quote.statusLabel}</span>
                  <span>{formatMoney(quote.total, quote.currencyCode ?? 'MXN')}</span>
                  {quote.convertible ? <Badge variant="success">Por convertir</Badge> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {panel.salesOrders.length > 0 ? (
            <ul className="ventas-list">
              {panel.salesOrders.map((order) => (
                <li key={order.id} className="ventas-list-item">
                  <Link href={salesOrderHref(order.id)}>
                    <strong>{order.salesOrderNumber ?? order.zohoSalesOrderId}</strong>
                  </Link>
                  <span>{formatMoney(order.total, order.currencyCode ?? 'MXN')}</span>
                  <span className="ventas-muted">{order.status ?? 'Sin estado'}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {panel.signals.length > 0 ? (
            <ul className="ventas-list">
              {panel.signals.map((signal) => (
                <li key={signal.id} className="ventas-list-item">
                  <Link href={ventasRadarHref({ signal: signal.id })}>
                    <strong>{signal.kindLabel}</strong>
                  </Link>
                  <span className="ventas-muted">{signal.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {panel.quotes.length === 0 &&
          panel.salesOrders.length === 0 &&
          panel.signals.length === 0 ? (
            <p className="ventas-hint">
              Este cliente todavía no tiene cotizaciones, órdenes ni señales del radar.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
