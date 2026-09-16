'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Alert, Button, FormField, Input, Select } from '@/components/ui/primitives';
import { requestVendorPickupAction, sendOrderToSupplierAction } from './compras-actions';

interface OrderOperationsView {
  id: string;
  number: string;
  status: string;
  statusLabel: string;
  deliveryMode: string;
  deliveryModeLabel: string;
  sentToSupplierAt: string | null;
  sentVia: string | null;
}

export interface OrderOperationsPanelProps {
  areaKey: string;
  orderId: string;
  canAct: boolean;
}

/**
 * The two commands that move an approved purchase order out of Compras:
 * sending the actual PO through an approved supplier channel and asking
 * Logística to collect it. Both choices stay explicit; no form field can
 * silently message a supplier or invent a pickup.
 */
export function OrderOperationsPanel({ areaKey, orderId, canAct }: OrderOperationsPanelProps) {
  const [order, setOrder] = useState<OrderOperationsView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [via, setVia] = useState<'pdf' | 'whatsapp' | 'sms' | 'telegram'>('pdf');
  const [pickupAddress, setPickupAddress] = useState('');
  const [readyAt, setReadyAt] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/compras/orders/${encodeURIComponent(orderId)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) throw new Error('order_fetch_failed');
      const body = (await response.json()) as { order: OrderOperationsView };
      setOrder(body.order);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  function send() {
    if (!order) return;
    setError(null);
    startTransition(async () => {
      const result = await sendOrderToSupplierAction({ orderId: order.id, via });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success(
        via === 'pdf'
          ? `PDF de ${order.number} generado y registrado`
          : `${order.number} enviado por ${via}`
      );
      await load();
    });
  }

  function requestPickup() {
    if (!order) return;
    const parsedWeight = weightKg.trim() === '' ? undefined : Number(weightKg);
    if (pickupAddress.trim().length < 8) {
      setError('Indica la dirección completa de recolección');
      return;
    }
    if (!readyAt) {
      setError('Indica cuándo estará listo el material');
      return;
    }
    if (parsedWeight !== undefined && (!Number.isFinite(parsedWeight) || parsedWeight <= 0)) {
      setError('El peso debe ser un número mayor que cero');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await requestVendorPickupAction({
        orderId: order.id,
        pickupAddress: pickupAddress.trim(),
        readyAt: new Date(readyAt).toISOString(),
        ...(parsedWeight === undefined ? {} : { weightKg: parsedWeight }),
      });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Logística ya tiene la solicitud formal de recolección');
      setPickupAddress('');
      setReadyAt('');
      setWeightKg('');
      await load();
    });
  }

  if (state === 'loading')
    return <LoadingState variant="list" rows={2} label="Cargando operaciones de la orden…" />;
  if (state === 'failed' || !order) {
    return (
      <ErrorState
        title="No pudimos abrir las operaciones de la orden"
        message="Recarga la página e inténtalo de nuevo."
      />
    );
  }

  const maySend = [
    'approved',
    'pending_payment',
    'awaiting_receipt',
    'partially_received',
  ].includes(order.status);
  const mayRequestPickup = order.deliveryMode === 'warehouse' && maySend;

  return (
    <section className="area-drawer-section" aria-labelledby="order-operations">
      <h3 id="order-operations" className="area-drawer-section-title">
        Coordinación de la orden
      </h3>
      <p className="area-row-sub">
        {order.number} · {order.statusLabel} · {order.deliveryModeLabel}
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}

      {!canAct ? (
        <p className="area-row-sub">
          Sólo quien gestiona Compras puede enviar o coordinar esta orden.
        </p>
      ) : null}

      {canAct && maySend ? (
        <div className="compras-response-form">
          <FormField
            label="Enviar orden al proveedor"
            htmlFor={`order-via-${order.id}`}
            help="PDF no envía un mensaje; los demás canales usan la bandeja configurada del proveedor."
          >
            <Select
              id={`order-via-${order.id}`}
              value={via}
              disabled={pending}
              onChange={(event) => setVia(event.target.value as typeof via)}
            >
              <option value="pdf">Generar PDF</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
              <option value="telegram">Telegram</option>
            </Select>
          </FormField>
          <div className="area-drawer-actions">
            <Button size="sm" disabled={pending} onClick={send}>
              {pending ? 'Procesando…' : via === 'pdf' ? 'Generar PDF de orden' : 'Enviar orden'}
            </Button>
          </div>
          {order.sentToSupplierAt ? (
            <p className="area-row-sub">Último envío: {order.sentVia ?? 'PDF'}.</p>
          ) : null}
        </div>
      ) : null}

      {canAct && mayRequestPickup ? (
        <div className="compras-response-form">
          <h4 className="area-drawer-section-title">Solicitar recolección a Logística</h4>
          <FormField label="Dirección de recolección" htmlFor={`pickup-address-${order.id}`}>
            <Input
              id={`pickup-address-${order.id}`}
              value={pickupAddress}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setPickupAddress(event.target.value)}
            />
          </FormField>
          <FormField label="Material listo desde" htmlFor={`pickup-ready-${order.id}`}>
            <Input
              id={`pickup-ready-${order.id}`}
              type="datetime-local"
              value={readyAt}
              disabled={pending}
              onChange={(event) => setReadyAt(event.target.value)}
            />
          </FormField>
          <FormField label="Peso estimado en kg (opcional)" htmlFor={`pickup-weight-${order.id}`}>
            <Input
              id={`pickup-weight-${order.id}`}
              inputMode="decimal"
              value={weightKg}
              disabled={pending}
              onChange={(event) => setWeightKg(event.target.value)}
            />
          </FormField>
          <div className="area-drawer-actions">
            <Button size="sm" variant="secondary" disabled={pending} onClick={requestPickup}>
              {pending ? 'Creando…' : 'Crear solicitud de recolección'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
