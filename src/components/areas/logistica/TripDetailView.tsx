'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Ban, Paperclip, PlayCircle, Smartphone, StopCircle } from 'lucide-react';
import { toast } from 'sonner';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Badge, Button, FormField, Textarea } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  DISPATCH_PATH,
  DRIVER_PATH,
  LOGISTICS_REALTIME_TYPES,
  cancelTripInput,
  closeTripInput,
  formatDayLabel,
  formatTime,
  startTripInput,
  tripChannel,
  tripProgress,
  tripStatusTone,
  type TripDetailData,
} from '@/modules/areas/logistica/logistics-view-model';
import { TripStopsEditor } from './TripStopsEditor';
import '@/styles/operations/logistica.css';

export interface TripDetailViewProps {
  user: { id: string; name: string };
  data: TripDetailData;
  /** Server time of the render, so the ETA labels match on hydration. */
  nowIso: string;
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
 * One trip (plan 7.1 `/app/areas/logistica/viajes/[id]`): its unit and driver,
 * the stops in order, the state of each delivery in Zoho and the evidence its
 * driver has already uploaded.
 *
 * Starting and closing the trip are engine commands; the driver runs the stops
 * from the PWA, and dispatch can do the same from here when it has to.
 */
export function TripDetailView({ user, data, nowIso }: TripDetailViewProps) {
  const router = useRouter();
  const { submit, online, pending } = useOfflineCommandQueue(user.id);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const { trip, deliveries, evidence, permissions, isDriver } = data;
  const progress = tripProgress(trip.stops);

  useOperationsRealtime(
    [tripChannel(trip.id)],
    LOGISTICS_REALTIME_TYPES,
    useCallback(() => router.refresh(), [router])
  );

  const runCommand = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      setBusy(true);
      try {
        const outcome = await submit<Record<string, unknown>>(input);
        const feedback = describeSubmitOutcome(outcome, successMessage);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh) router.refresh();
        return feedback.kind === 'success' || feedback.kind === 'queued';
      } finally {
        setBusy(false);
      }
    },
    [submit, router]
  );

  const canOperate = permissions.canDispatch || isDriver;
  const evidenceEntries = Object.entries(evidence).filter(([, items]) => items.length > 0);
  // Plan §4: el viaje que no va a salir se cancela; sus entregas regresan a
  // Despacho sin marcarse como fallidas. Es decisión de despacho, no del chofer.
  const canCancel =
    permissions.canDispatch && (trip.status === 'planned' || trip.status === 'en_route');

  async function cancelTrip() {
    const reason = cancelReason.trim();
    if (!reason) {
      setCancelError('Indica por qué se cancela el viaje.');
      return;
    }
    const done = await runCommand(cancelTripInput(trip, reason), 'Viaje cancelado');
    if (done) {
      setCancelOpen(false);
      setCancelReason('');
      setCancelError(null);
    }
  }

  return (
    <div className="trip-page">
      {!online || pending > 0 ? (
        <Alert variant={online ? 'info' : 'warning'}>
          {online
            ? `${pending} ${pending === 1 ? 'acción pendiente' : 'acciones pendientes'} de enviar.`
            : `Sin conexión${pending > 0 ? ` · ${pending} pendientes` : ''}. Tus acciones se enviarán al reconectar.`}
        </Alert>
      ) : null}

      <div className="dispatch-toolbar">
        <div className="dispatch-toolbar-group">
          <Badge variant={BADGE_BY_TONE[tripStatusTone(trip.status)]}>{trip.statusLabel}</Badge>
          <span className="dispatch-day">{trip.number}</span>
          <span className="dispatch-column-hint">{formatDayLabel(trip.date)}</span>
        </div>
        <div className="dispatch-toolbar-group">
          <Link className="btn btn-ghost btn-sm" href={DISPATCH_PATH}>
            Volver a Despacho
          </Link>
          {isDriver ? (
            <Link className="btn btn-secondary btn-sm" href={DRIVER_PATH}>
              <Smartphone size={14} aria-hidden="true" />
              Abrir vista de chofer
            </Link>
          ) : null}
          {canOperate && trip.status === 'planned' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void runCommand(startTripInput(trip), 'Viaje iniciado')}
            >
              <PlayCircle size={14} aria-hidden="true" />
              Iniciar viaje
            </Button>
          ) : null}
          {canOperate && trip.status === 'en_route' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || progress.pending > 0}
              title={
                progress.pending > 0
                  ? 'Cada parada debe estar entregada o marcada como fallida'
                  : undefined
              }
              onClick={() => void runCommand(closeTripInput(trip), 'Viaje cerrado')}
            >
              <StopCircle size={14} aria-hidden="true" />
              Cerrar viaje
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setCancelError(null);
                setCancelOpen(true);
              }}
            >
              <Ban size={14} aria-hidden="true" />
              Cancelar viaje
            </Button>
          ) : null}
        </div>
      </div>

      {cancelOpen ? (
        <Dialog open onOpenChange={(open) => (!open && !busy ? setCancelOpen(false) : undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Cancelar el viaje {trip.number}</DialogTitle>
              <DialogDescription>
                Las {progress.total} parada(s) no se marcan como fallidas: sus entregas regresan a
                Despacho para volver a programarse. Un viaje que ya entregó algo se cierra, no se
                cancela.
              </DialogDescription>
            </DialogHeader>
            <FormField
              label="Motivo"
              htmlFor="trip-cancel-reason"
              help="Queda en la bitácora del viaje y de cada entrega."
              error={cancelError}
            >
              <Textarea
                id="trip-cancel-reason"
                rows={3}
                maxLength={500}
                autoFocus
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Se descompuso la unidad"
              />
            </FormField>
            {!online ? (
              <Alert variant="info">
                Sin conexión: la cancelación se guarda en este dispositivo y se envía al volver.
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCancelOpen(false)}
                disabled={busy}
              >
                Volver
              </Button>
              <Button variant="danger" size="sm" onClick={() => void cancelTrip()} disabled={busy}>
                {busy ? 'Cancelando…' : 'Cancelar viaje'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <dl className="trip-summary">
        <div className="trip-summary-item">
          <dt>Unidad</dt>
          <dd>{trip.vehicle ? `${trip.vehicle.label} · ${trip.vehicle.plate}` : 'Sin unidad'}</dd>
        </div>
        <div className="trip-summary-item">
          <dt>Chofer</dt>
          <dd>{trip.driver?.name ?? 'Sin chofer'}</dd>
        </div>
        <div className="trip-summary-item">
          <dt>Avance</dt>
          <dd>{progress.label}</dd>
        </div>
        <div className="trip-summary-item">
          <dt>Salida</dt>
          <dd>{trip.startedAt ? formatTime(trip.startedAt) : 'Sin salir'}</dd>
        </div>
        <div className="trip-summary-item">
          <dt>Cierre</dt>
          <dd>{trip.endedAt ? formatTime(trip.endedAt) : '—'}</dd>
        </div>
        {trip.notes ? (
          <div className="trip-summary-item">
            <dt>Notas</dt>
            <dd>{trip.notes}</dd>
          </div>
        ) : null}
      </dl>

      <span className="dispatch-progress" aria-hidden="true">
        <span className="dispatch-progress-bar" style={{ width: `${progress.percent}%` }} />
      </span>

      <section className="grid gap-2" aria-labelledby="trip-stops-title">
        <h3 id="trip-stops-title" className="area-drawer-section-title">
          Paradas
        </h3>
        <TripStopsEditor
          trip={trip}
          deliveries={deliveries}
          canDispatch={permissions.canDispatch}
          now={now}
          onSubmit={runCommand}
        />
      </section>

      <section className="grid gap-2" aria-labelledby="trip-evidence-title">
        <h3 id="trip-evidence-title" className="area-drawer-section-title">
          Evidencias
        </h3>
        {evidenceEntries.length === 0 ? (
          <p className="dispatch-column-hint">
            Todavía no hay evidencias. El chofer las sube al registrar cada entrega.
          </p>
        ) : (
          <ul className="area-evidence-list">
            {evidenceEntries.map(([deliveryId, items]) => {
              const delivery = deliveries.find((entry) => entry.id === deliveryId);
              return (
                <li key={deliveryId} className="area-evidence-item">
                  <Paperclip size={14} aria-hidden="true" />
                  <span>
                    {delivery?.customerName ?? delivery?.caseNumber ?? 'Entrega'}:{' '}
                    {items
                      .map(
                        (item) =>
                          `${item.kindLabel}${item.createdByName ? ` (${item.createdByName})` : ''}`
                      )
                      .join(', ')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
