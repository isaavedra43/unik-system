'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  MapPin,
  Navigation,
  PenLine,
  Phone,
  PlayCircle,
  RefreshCw,
  StopCircle,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { ErrorState } from '@/components/patterns/ErrorState';
import { Alert, Badge, Button, FormField, Input, Textarea } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import { uploadFile } from '@/lib/upload-client';
import type {
  DriverToday,
  DriverTodayStop,
  DriverTodayTrip,
} from '@/modules/logistics/driver-service';
import {
  LOGISTICS_API,
  LOGISTICS_REALTIME_TYPES,
  arriveStopInput,
  checkDeliveredLines,
  closeTripInput,
  completeStopInput,
  deliveryBlockReason,
  failStopInput,
  formatDayLabel,
  formatTime,
  formatWindow,
  navigationUrl,
  pickDriverStop,
  startTripInput,
  stopStatusTone,
  tripChannel,
  tripProgress,
  type GeoPointDTO,
} from '@/modules/areas/logistica/logistics-view-model';
import { requestBackgroundSync, sendDriverCommand } from './driver-commands';
import '@/styles/operations/logistica.css';

export interface DriverAppProps {
  user: { id: string; name: string };
  initial: DriverToday;
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

/** GPS of the phone; never blocks the flow (a stop can be closed without it). */
function currentPosition(): Promise<GeoPointDTO | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 }
    );
  });
}

/**
 * Vista de chofer (plan 6.3): el viaje del día, sus paradas en orden, llegar,
 * entregar con cantidades y evidencia, y registrar una incidencia cuando no se
 * pudo entregar.
 *
 * Todo sale por comandos idempotentes: en línea van al endpoint de chofer y sin
 * señal se quedan en la cola del dispositivo, que el service worker reenvía con
 * Background Sync. Repetir un comando nunca entrega dos veces.
 */
export function DriverApp({ user, initial, nowIso }: DriverAppProps) {
  const [today, setToday] = useState<DriverToday>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { online, pending } = useOfflineCommandQueue(user.id);
  const now = useMemo(() => new Date(nowIso), [nowIso]);

  const trip = today.trips.find((entry) => entry.status === 'en_route') ?? today.trips[0] ?? null;
  const current = trip ? pickDriverStop(trip.stops) : null;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(LOGISTICS_API.driverToday());
      const json = (await response.json().catch(() => ({}))) as DriverToday & { error?: string };
      if (!response.ok || !Array.isArray(json.trips)) {
        throw new Error(json.error ?? 'No pudimos actualizar tu viaje');
      }
      setToday(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos actualizar tu viaje');
    } finally {
      setLoading(false);
    }
  }, []);

  useOperationsRealtime(
    trip ? [tripChannel(trip.tripId)] : [],
    LOGISTICS_REALTIME_TYPES,
    useCallback(() => void reload(), [reload])
  );

  useEffect(() => {
    if (online && pending > 0) requestBackgroundSync();
  }, [online, pending]);

  const run = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      setBusy(true);
      try {
        const outcome = await sendDriverCommand(input);
        const feedback = describeSubmitOutcome(outcome, successMessage);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh || feedback.kind === 'queued') await reload();
        return feedback.kind === 'success' || feedback.kind === 'queued';
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  if (!today.driver) {
    return (
      <div className="driver-app">
        <Alert variant="info">
          Tu usuario todavía no está ligado a un chofer. Pídele a Logística que lo ligue en Flotilla
          para ver aquí tus viajes.
        </Alert>
      </div>
    );
  }

  return (
    <div className="driver-app">
      <header className="driver-header">
        <div>
          <strong>{today.driver.name}</strong>
          <p className="dispatch-column-hint">{formatDayLabel(today.date)}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
          Actualizar
        </Button>
      </header>

      {!online || pending > 0 ? (
        <Alert variant={online ? 'info' : 'warning'}>
          {online
            ? `${pending} ${pending === 1 ? 'acción pendiente' : 'acciones pendientes'} de enviar.`
            : `Sin conexión${pending > 0 ? ` · ${pending} pendientes` : ''}. Lo que registres se enviará solo al volver la señal.`}
        </Alert>
      ) : null}

      {error ? (
        <ErrorState title="No pudimos actualizar" message={error} onRetry={() => void reload()} />
      ) : null}

      {!trip ? (
        <div className="area-empty">
          <strong>Sin viajes hoy</strong>
          <p>Cuando Logística te asigne un viaje, aparecerá aquí con sus paradas.</p>
        </div>
      ) : (
        <>
          <TripHeader trip={trip} busy={busy} onRun={run} />
          {current ? (
            <StopWorkspace
              key={current.stop.stopId}
              trip={trip}
              stop={current.stop}
              reason={current.reason}
              online={online}
              busy={busy}
              onRun={run}
              onUploaded={() => void reload()}
            />
          ) : (
            <Alert variant="success">
              Terminaste todas las paradas de este viaje. Ciérralo para que Logística lo dé por
              concluido.
            </Alert>
          )}
          <StopList trip={trip} currentStopId={current?.stop.stopId ?? null} now={now} />
        </>
      )}
    </div>
  );
}

type RunCommand = (
  input: OfflineCommandInput<Record<string, unknown>>,
  successMessage: string
) => Promise<boolean>;

function TripHeader({
  trip,
  busy,
  onRun,
}: {
  trip: DriverTodayTrip;
  busy: boolean;
  onRun: RunCommand;
}) {
  const progress = tripProgress(trip.stops.map((stop) => ({ status: stop.status })));
  const aggregate = { id: trip.tripId, version: trip.version };

  return (
    <section className="driver-trip" aria-label={`Viaje ${trip.number}`}>
      <div className="driver-trip-head">
        <div>
          <strong>{trip.number}</strong>
          <p className="dispatch-column-hint">
            {trip.vehicle ? `${trip.vehicle.label} · ${trip.vehicle.plate}` : 'Sin unidad'}
          </p>
        </div>
        <Badge variant={trip.status === 'en_route' ? 'info' : 'default'}>
          {trip.status === 'en_route'
            ? 'En ruta'
            : trip.status === 'done'
              ? 'Terminado'
              : 'Planeado'}
        </Badge>
      </div>
      <p className="dispatch-column-hint">{progress.label}</p>
      <span className="dispatch-progress" aria-hidden="true">
        <span className="dispatch-progress-bar" style={{ width: `${progress.percent}%` }} />
      </span>
      {trip.notes ? <p className="dispatch-column-hint">{trip.notes}</p> : null}
      <div className="driver-actions">
        {trip.status === 'planned' ? (
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => void onRun(startTripInput(aggregate), 'Viaje iniciado')}
          >
            <PlayCircle size={16} aria-hidden="true" />
            Iniciar viaje
          </Button>
        ) : null}
        {trip.status === 'en_route' && progress.pending === 0 ? (
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => void onRun(closeTripInput(aggregate), 'Viaje cerrado')}
          >
            <StopCircle size={16} aria-hidden="true" />
            Cerrar viaje
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function StopWorkspace({
  trip,
  stop,
  reason,
  online,
  busy,
  onRun,
  onUploaded,
}: {
  trip: DriverTodayTrip;
  stop: DriverTodayStop;
  reason: string;
  online: boolean;
  busy: boolean;
  onRun: RunCommand;
  onUploaded: () => void;
}) {
  const order = stop.deliveryOrder;
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [receivedBy, setReceivedBy] = useState(order?.receivedBy ?? '');
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadedIds, setUploadedIds] = useState<string[]>([]);
  const photoRef = useRef<HTMLInputElement>(null);
  const signatureRef = useRef<HTMLInputElement>(null);

  if (!order) {
    return (
      <Alert variant="warning">
        Esta parada ya no tiene su entrega disponible. Actualiza la pantalla o avisa a Logística.
      </Alert>
    );
  }

  const aggregate = { id: trip.tripId, version: trip.version };
  const navigate = navigationUrl(order.coordinates, {
    line: order.address.line,
    city: order.address.city,
    state: order.address.state,
  });
  const evidenceCount =
    order.evidence.filter((item) => item.kind === 'photo' || item.kind === 'signature').length +
    uploadedIds.length;
  const blocked = deliveryBlockReason({ receivedBy, evidenceCount, online });
  const deliveryWindow = formatWindow(order.window.start, order.window.end);

  async function upload(file: File, kind: 'photo' | 'signature') {
    setUploading(true);
    try {
      const target =
        kind === 'photo' ? order!.evidenceUpload.photo : order!.evidenceUpload.signature;
      const result = await uploadFile(file, { target });
      if (result.status !== 'ready') {
        toast.error(result.rejectionReason ?? 'El archivo no pasó la validación');
        return;
      }
      setUploadedIds((current) => [...new Set([...current, result.objectId])]);
      toast.success(kind === 'photo' ? 'Foto adjuntada' : 'Firma adjuntada');
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir la evidencia');
    } finally {
      setUploading(false);
      if (photoRef.current) photoRef.current.value = '';
      if (signatureRef.current) signatureRef.current.value = '';
    }
  }

  async function arrive() {
    await onRun(
      arriveStopInput(aggregate, stop.stopId, await currentPosition()),
      'Llegada registrada'
    );
  }

  async function deliver() {
    const check = checkDeliveredLines(
      order!.lines,
      Object.entries(quantities).map(([allocationId, value]) => ({ allocationId, value }))
    );
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    const done = await onRun(
      completeStopInput(aggregate, stop.stopId, {
        lines: check.lines,
        receivedBy,
        evidenceObjectIds: uploadedIds,
        note,
        ...(check.short
          ? { partialReason: note || 'Entrega parcial registrada por el chofer' }
          : {}),
        coordinates: await currentPosition(),
      }),
      check.short ? 'Entrega parcial registrada' : 'Entrega registrada'
    );
    if (done) {
      setUploadedIds([]);
      setQuantities({});
      setNote('');
    }
  }

  async function fail() {
    const text = askFailureReason();
    if (!text) return;
    await onRun(
      failStopInput(aggregate, stop.stopId, text, await currentPosition()),
      'Incidencia registrada'
    );
  }

  return (
    <section className="driver-stop driver-stop-current" aria-label="Parada actual">
      <p className="dispatch-column-hint">{reason}</p>
      <h3 className="driver-stop-title">
        {stop.sequence}. {order.customerName ?? order.caseNumber ?? 'Entrega'}
      </h3>
      <p className="driver-stop-address">
        <MapPin size={14} aria-hidden="true" />{' '}
        {[order.address.line, order.address.city, order.address.state].filter(Boolean).join(', ') ||
          'Sin dirección'}
      </p>
      <p className="dispatch-column-hint">
        {[order.salesOrderNumber ?? order.caseNumber, deliveryWindow, formatTime(stop.etaAt)]
          .filter(Boolean)
          .join(' · ')}
      </p>

      <div className="driver-actions">
        {navigate ? (
          <a className="btn btn-secondary btn-sm" href={navigate} target="_blank" rel="noreferrer">
            <Navigation size={16} aria-hidden="true" />
            Cómo llegar
          </a>
        ) : null}
        {order.contact.phone ? (
          <a className="btn btn-secondary btn-sm" href={`tel:${order.contact.phone}`}>
            <Phone size={16} aria-hidden="true" />
            Llamar
          </a>
        ) : null}
        {stop.status === 'pending' ? (
          <Button variant="primary" size="md" disabled={busy} onClick={() => void arrive()}>
            <CheckCircle2 size={16} aria-hidden="true" />
            Llegué
          </Button>
        ) : null}
      </div>

      <ul className="driver-lines">
        {order.lines.map((line) => (
          <li key={line.allocationId} className="driver-line">
            <span className="driver-line-name">
              {line.name}
              <span>
                {line.sku ? `${line.sku} · ` : ''}Faltan {line.pendingQuantity} {line.unit}
              </span>
            </span>
            <Input
              aria-label={`Cantidad entregada de ${line.name}`}
              inputMode="decimal"
              placeholder={String(line.pendingQuantity)}
              value={quantities[line.allocationId] ?? ''}
              onChange={(event) =>
                setQuantities((current) => ({
                  ...current,
                  [line.allocationId]: event.target.value,
                }))
              }
            />
          </li>
        ))}
      </ul>

      <FormField label="Quién recibió" htmlFor="driver-received">
        <Input
          id="driver-received"
          value={receivedBy}
          onChange={(event) => setReceivedBy(event.target.value)}
          placeholder="Nombre de quien recibe"
        />
      </FormField>

      <FormField label="Nota (opcional)" htmlFor="driver-note">
        <Textarea
          id="driver-note"
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Algo que Logística deba saber"
        />
      </FormField>

      <div className="driver-evidence">
        <span className="form-label">Evidencia de la entrega</span>
        <div className="driver-actions">
          <label className="btn btn-secondary btn-sm" htmlFor="driver-photo">
            <Camera size={16} aria-hidden="true" />
            {uploading ? 'Subiendo…' : 'Tomar foto'}
          </label>
          <input
            id="driver-photo"
            ref={photoRef}
            className="sr-only"
            type="file"
            accept="image/*"
            capture="environment"
            disabled={uploading || !online}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file, 'photo');
            }}
          />
          <label className="btn btn-secondary btn-sm" htmlFor="driver-signature">
            <PenLine size={16} aria-hidden="true" />
            Firma o acuse
          </label>
          <input
            id="driver-signature"
            ref={signatureRef}
            className="sr-only"
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            disabled={uploading || !online}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file, 'signature');
            }}
          />
        </div>
        <div className="driver-evidence-list">
          {evidenceCount === 0 ? (
            <span>Sin evidencia todavía</span>
          ) : (
            <span>
              {evidenceCount} {evidenceCount === 1 ? 'archivo adjunto' : 'archivos adjuntos'}
            </span>
          )}
        </div>
      </div>

      {blocked ? <Alert variant="warning">{blocked}</Alert> : null}

      <div className="driver-sticky">
        <Button
          variant="primary"
          size="lg"
          disabled={busy || Boolean(blocked)}
          onClick={() => void deliver()}
        >
          <CheckCircle2 size={18} aria-hidden="true" />
          Registrar entrega
        </Button>
        {/* La acción esperada es «Registrar entrega»: el fallo va en contorno. */}
        <Button
          variant="secondary"
          className="btn-danger-outline"
          size="lg"
          disabled={busy}
          onClick={() => void fail()}
        >
          <TriangleAlert size={18} aria-hidden="true" />
          No se pudo entregar
        </Button>
      </div>
    </section>
  );
}

/** Motivo de una entrega fallida. Se aísla para no llamar a `window` durante el render. */
function askFailureReason(): string | null {
  const text = window.prompt('¿Por qué no se pudo entregar?')?.trim();
  return text ? text : null;
}

function StopList({
  trip,
  currentStopId,
  now,
}: {
  trip: DriverTodayTrip;
  currentStopId: string | null;
  now: Date;
}) {
  const rest = trip.stops.filter((stop) => stop.stopId !== currentStopId);
  if (rest.length === 0) return null;
  return (
    <section className="grid gap-2" aria-label="Resto de las paradas">
      <h3 className="area-drawer-section-title">Resto de la ruta</h3>
      {rest.map((stop) => (
        <article
          key={stop.stopId}
          className={`driver-stop ${stop.status === 'done' ? 'driver-stop-done' : ''}`}
        >
          <div className="driver-trip-head">
            <div>
              <strong>
                {stop.sequence}.{' '}
                {stop.deliveryOrder?.customerName ?? stop.deliveryOrder?.caseNumber ?? 'Entrega'}
              </strong>
              <p className="dispatch-column-hint">
                {stop.deliveryOrder?.address.city ?? 'Sin ciudad'} ·{' '}
                {stop.etaAt ? `~${formatTime(stop.etaAt)}` : 'Sin hora estimada'}
              </p>
            </div>
            <Badge variant={BADGE_BY_TONE[stopStatusTone(stop.status)]}>
              {stop.status === 'done'
                ? 'Entregada'
                : stop.status === 'failed'
                  ? 'Fallida'
                  : stop.status === 'arrived'
                    ? 'En el sitio'
                    : 'Pendiente'}
            </Badge>
          </div>
        </article>
      ))}
      <p className="dispatch-column-hint">
        Actualizado {formatTime(now.toISOString())}. Las paradas se atienden en orden.
      </p>
    </section>
  );
}
