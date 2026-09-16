import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { AreaRowTone } from '@/modules/areas/area-work-row';
import { normalizeVehicleCode } from '@/modules/logistics/fleet-rules';
import {
  DELIVERY_MODE_LABELS,
  DELIVERY_ORDER_STATUS_LABELS,
  LOGISTICS_COMMANDS,
  LOGISTICS_OBJECT_TYPES,
  SHIPPING_MODES,
  TRIP_STATUS_LABELS,
  TRIP_STOP_STATUS_LABELS,
  type DeliveryMode,
  type DeliveryOrderStatus,
  type TripStatus,
  type TripStopStatus,
} from '@/modules/logistics/types';
import {
  ZOHO_SYNC_STATE_LABELS,
  failedZohoOperation,
  isZohoSyncState,
  pendingZohoOperation,
  ZOHO_OPERATION_LABELS,
} from '@/modules/logistics/zoho-sync-state';

/**
 * View model of the Logística area (plan 7.3, 7.4, 7.6 and 7.10). PURE and
 * ISOMORPHIC: no Prisma, no React, no I/O — the server queries build these
 * shapes, the dispatch board, the trip page and the driver PWA render them, and
 * the unit test walks the rules.
 *
 * Everything a person can trigger is expressed as a command input for
 * `POST /app/operations/api/commands` (offline queue included); nothing here
 * decides business outcomes — the engine validates every command again.
 */

// ---------------------------------------------------------------------------
// DTOs shared by the server queries and the client views
// ---------------------------------------------------------------------------

export interface GeoPointDTO {
  lat: number;
  lng: number;
}

export interface DeliveryLineDTO {
  allocationId: string;
  demandId: string;
  sku: string | null;
  name: string;
  unit: string;
  /** Quantity of the allocation. */
  quantity: number;
  deliveredQuantity: number;
  /** What this delivery still owes. */
  pendingQuantity: number;
}

export interface DeliveryEvidenceDTO {
  id: string;
  kind: string;
  kindLabel: string;
  note: string | null;
  storageObjectId: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface DispatchDelivery {
  id: string;
  version: number;
  status: string;
  statusLabel: string;
  tone: AreaRowTone;
  mode: string;
  modeLabel: string;
  caseId: string;
  caseNumber: string | null;
  salesOrderNumber: string | null;
  customerName: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  plannedDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  address: {
    line: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  contact: { name: string | null; phone: string | null };
  coordinates: GeoPointDTO | null;
  tripId: string | null;
  tripNumber: string | null;
  vehicleId: string | null;
  vehicleLabel: string | null;
  driverId: string | null;
  driverName: string | null;
  packageId: string | null;
  zohoPackageId: string | null;
  zohoSyncState: string;
  zohoError: string | null;
  /** Fields Zoho holds that differ from what UNIK asked to write. */
  zohoDifferences: Array<{ label: string; expected: string | null; actual: string | null }>;
  lines: DeliveryLineDTO[];
  pendingUnits: number;
  evidenceCount: number;
  deliveredAt: string | null;
  receivedBy: string | null;
  partialReason: string | null;
  open: boolean;
}

export interface DispatchStop {
  id: string;
  sequence: number;
  status: string;
  statusLabel: string;
  etaAt: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  deliveryOrderId: string;
  coordinates: GeoPointDTO | null;
}

export interface DispatchVehicle {
  id: string;
  code: string;
  plate: string;
  label: string;
  capacityKg: number | null;
  capacityM2: number | null;
  capacityPieces: number | null;
  maintenanceUntil: string | null;
  active: boolean;
  available: boolean;
  reasons: string[];
}

export interface DispatchDriver {
  id: string;
  name: string;
  phone: string | null;
  licenseNumber: string | null;
  userId: string | null;
  active: boolean;
  available: boolean;
  reasons: string[];
}

export interface DispatchTrip {
  id: string;
  version: number;
  number: string;
  date: string;
  status: string;
  statusLabel: string;
  startedAt: string | null;
  endedAt: string | null;
  notes: string | null;
  vehicle: { id: string; code: string; label: string; plate: string } | null;
  driver: { id: string; name: string; phone: string | null } | null;
  stops: DispatchStop[];
}

export interface DispatchPermissions {
  canDispatch: boolean;
  canManageFleet: boolean;
  canWriteZoho: boolean;
  canDrive: boolean;
  /** The person may open the area copilot on this surface. */
  canUseAssistant: boolean;
}

export interface DispatchBoardData {
  /** Day the board is showing (YYYY-MM-DD). */
  date: string;
  generatedAt: string;
  deliveries: DispatchDelivery[];
  trips: DispatchTrip[];
  vehicles: DispatchVehicle[];
  drivers: DispatchDriver[];
  permissions: DispatchPermissions;
  /** Real counters of the day, computed by the server. */
  counters: {
    unassigned: number;
    onTrips: number;
    inTransit: number;
    zohoPending: number;
    failed: number;
    tripsActive: number;
  };
}

export interface TripDetailData {
  trip: DispatchTrip;
  deliveries: DispatchDelivery[];
  evidence: Record<string, DeliveryEvidenceDTO[]>;
  permissions: DispatchPermissions;
  /** The signed-in person is the driver of this trip. */
  isDriver: boolean;
  generatedAt: string;
}

export interface FleetOverviewData {
  date: string;
  vehicles: DispatchVehicle[];
  drivers: DispatchDriver[];
  trips: Array<{
    id: string;
    number: string;
    date: string;
    status: string;
    vehicleId: string;
    driverId: string;
  }>;
  permissions: DispatchPermissions;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Labels and tones
// ---------------------------------------------------------------------------

const DELIVERY_TONES: Readonly<Record<DeliveryOrderStatus, AreaRowTone>> = {
  pending: 'default',
  planned: 'default',
  assigned: 'info',
  pending_external: 'warning',
  conflict: 'danger',
  dispatched: 'info',
  delivered: 'success',
  partially_delivered: 'warning',
  failed: 'danger',
  cancelled: 'weak',
};

const TRIP_TONES: Readonly<Record<TripStatus, AreaRowTone>> = {
  planned: 'default',
  en_route: 'info',
  done: 'success',
  cancelled: 'weak',
};

const STOP_TONES: Readonly<Record<TripStopStatus, AreaRowTone>> = {
  pending: 'default',
  arrived: 'info',
  done: 'success',
  failed: 'danger',
};

export function deliveryStatusLabel(status: string): string {
  return (DELIVERY_ORDER_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function deliveryStatusTone(status: string): AreaRowTone {
  return (DELIVERY_TONES as Record<string, AreaRowTone>)[status] ?? 'default';
}

export function tripStatusLabel(status: string): string {
  return (TRIP_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function tripStatusTone(status: string): AreaRowTone {
  return (TRIP_TONES as Record<string, AreaRowTone>)[status] ?? 'default';
}

export function stopStatusLabel(status: string): string {
  return (TRIP_STOP_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function stopStatusTone(status: string): AreaRowTone {
  return (STOP_TONES as Record<string, AreaRowTone>)[status] ?? 'default';
}

export function deliveryModeLabel(mode: string): string {
  return (DELIVERY_MODE_LABELS as Record<string, string>)[mode] ?? mode;
}

/** Modes that travel on a trip of the own fleet. */
export function ridesOwnFleet(mode: string): boolean {
  return mode === 'own_fleet';
}

// ---------------------------------------------------------------------------
// Zoho pill (plan 7.6: "Escribir en Zoho" para pending_external | conflict)
// ---------------------------------------------------------------------------

export type ZohoPillTone = 'success' | 'warning' | 'danger' | 'info' | 'weak';

export interface ZohoPill {
  /** Short text of the pill. */
  label: string;
  tone: ZohoPillTone;
  /** Sentence explaining what is happening, in Spanish. */
  detail: string;
  /** The delivery needs a person to decide: the pill becomes a button. */
  actionable: boolean;
  /** Label of that button ("Escribir en Zoho"). */
  actionLabel: string | null;
}

export const ZOHO_WRITE_ACTION_LABEL = 'Escribir en Zoho';

/**
 * State of the Zoho mirror of a delivery, as a pill. `null` when the delivery
 * never writes to Zoho (pickup or direct supplier without a package).
 */
export function zohoPill(
  order: Pick<DispatchDelivery, 'status' | 'zohoSyncState' | 'zohoError' | 'mode'>
): ZohoPill | null {
  const state = isZohoSyncState(order.zohoSyncState) ? order.zohoSyncState : null;
  if (!state) return null;
  const stateLabel = ZOHO_SYNC_STATE_LABELS[state];

  if (order.status === 'conflict' || state === 'readback_mismatch') {
    return {
      label: 'Zoho guardó otros valores',
      tone: 'danger',
      detail:
        'Zoho es la autoridad del paquete: se muestran sus valores. Vuelve a escribir el embarque o acepta lo que Zoho tiene cerrando el trabajo de sincronización.',
      actionable: true,
      actionLabel: ZOHO_WRITE_ACTION_LABEL,
    };
  }
  if (state === 'failed') {
    const operation = failedZohoOperation(order.status, state);
    return {
      label: 'Falló la escritura en Zoho',
      tone: 'danger',
      detail: operation
        ? `No se pudo ${ZOHO_OPERATION_LABELS[operation]} en Zoho${order.zohoError ? `: ${order.zohoError}` : ''}. Vuelve a intentarlo cuando Zoho responda.`
        : stateLabel,
      actionable: true,
      actionLabel: ZOHO_WRITE_ACTION_LABEL,
    };
  }
  const pending = pendingZohoOperation(order.status, state);
  if (pending) {
    return {
      label: 'Esperando a Zoho',
      tone: 'warning',
      detail: `UNIK está por ${ZOHO_OPERATION_LABELS[pending]} en Zoho; la confirmación llega sola.`,
      actionable: false,
      actionLabel: null,
    };
  }
  if (state === 'written') {
    return {
      label: 'Falta releer Zoho',
      tone: 'warning',
      detail: 'Se escribió en Zoho y falta la relectura que lo confirma (cada 30 minutos).',
      actionable: false,
      actionLabel: null,
    };
  }
  if (state === 'readback_ok') {
    return {
      label: 'Confirmado por Zoho',
      tone: 'success',
      detail: 'Zoho devolvió el mismo embarque que pidió UNIK.',
      actionable: false,
      actionLabel: null,
    };
  }
  if (state === 'delivered_written') {
    return {
      label: 'Entrega marcada en Zoho',
      tone: 'success',
      detail: 'Zoho ya tiene el paquete como entregado.',
      actionable: false,
      actionLabel: null,
    };
  }
  return null;
}

/** True when a dispatcher still has to (re)write the shipment order in Zoho. */
export function needsZohoWrite(
  order: Pick<DispatchDelivery, 'status' | 'zohoSyncState' | 'mode'>
): boolean {
  const pill = zohoPill({ ...order, zohoError: null });
  return pill?.actionable === true;
}

// ---------------------------------------------------------------------------
// Board grouping
// ---------------------------------------------------------------------------

export interface DispatchGroups {
  /** Open deliveries with no trip: the drag source of the board. */
  unassigned: DispatchDelivery[];
  /** Open deliveries already loaded on a trip. */
  onTrips: DispatchDelivery[];
  /** Deliveries whose Zoho mirror needs a decision. */
  zohoAttention: DispatchDelivery[];
  /** Closed today (delivered, partially delivered or cancelled). */
  closed: DispatchDelivery[];
}

/** Buckets of the dispatch board, each ordered by what runs out of time first. */
export function groupDispatchDeliveries(deliveries: readonly DispatchDelivery[]): DispatchGroups {
  const groups: DispatchGroups = { unassigned: [], onTrips: [], zohoAttention: [], closed: [] };
  for (const delivery of deliveries) {
    if (!delivery.open) groups.closed.push(delivery);
    else if (delivery.tripId) groups.onTrips.push(delivery);
    else groups.unassigned.push(delivery);
    if (delivery.open && needsZohoWrite(delivery)) groups.zohoAttention.push(delivery);
  }
  groups.unassigned.sort(byUrgency);
  groups.onTrips.sort(byUrgency);
  groups.zohoAttention.sort(byUrgency);
  groups.closed.sort(
    (a, b) =>
      Date.parse(b.deliveredAt ?? '') - Date.parse(a.deliveredAt ?? '') || a.id.localeCompare(b.id)
  );
  return groups;
}

function timeOf(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * What runs out of time first: the end of the delivery window when there is
 * one, otherwise the planned day (a day-granularity value that must never hide
 * an intraday window), and last whatever has no date at all.
 */
function byUrgency(a: DispatchDelivery, b: DispatchDelivery): number {
  const left = a.windowEnd ? timeOf(a.windowEnd) : timeOf(a.plannedDate);
  const right = b.windowEnd ? timeOf(b.windowEnd) : timeOf(b.plannedDate);
  return left - right || a.id.localeCompare(b.id);
}

export interface TripProgress {
  total: number;
  done: number;
  failed: number;
  pending: number;
  /** 0–100, counting done and failed stops as visited. */
  percent: number;
  label: string;
}

export function tripProgress(stops: readonly Pick<DispatchStop, 'status'>[]): TripProgress {
  const total = stops.length;
  const done = stops.filter((stop) => stop.status === 'done').length;
  const failed = stops.filter((stop) => stop.status === 'failed').length;
  const pending = total - done - failed;
  const percent = total === 0 ? 0 : Math.round(((done + failed) / total) * 100);
  const label =
    total === 0
      ? 'Sin paradas'
      : `${done} de ${total} entregadas${failed > 0 ? ` · ${failed} fallida${failed === 1 ? '' : 's'}` : ''}`;
  return { total, done, failed, pending, percent, label };
}

/** Trip a delivery can still be added to: active and of the same day (or already running). */
export function tripsAcceptingStops(trips: readonly DispatchTrip[]): DispatchTrip[] {
  return trips.filter((trip) => trip.status === 'planned' || trip.status === 'en_route');
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export interface MapPoint extends GeoPointDTO {
  id: string;
  label: string;
  /** `stop` belongs to a trip; `loose` is an unassigned delivery. */
  kind: 'stop' | 'loose';
  tripId: string | null;
  sequence: number | null;
  tone: AreaRowTone;
  deliveryOrderId: string;
}

/** Center of Guadalajara: the fallback when no delivery has coordinates yet. */
export const DEFAULT_MAP_CENTER: GeoPointDTO = { lat: 20.6597, lng: -103.3496 };
export const DEFAULT_MAP_ZOOM = 11;

export function isUsablePoint(point: GeoPointDTO | null | undefined): point is GeoPointDTO {
  return (
    !!point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180 &&
    !(point.lat === 0 && point.lng === 0)
  );
}

/** Markers of the board: one per stop with coordinates plus the loose deliveries. */
export function buildMapPoints(
  deliveries: readonly DispatchDelivery[],
  trips: readonly DispatchTrip[]
): MapPoint[] {
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  const points: MapPoint[] = [];
  const onTrip = new Set<string>();
  for (const trip of trips) {
    for (const stop of trip.stops) {
      const delivery = byId.get(stop.deliveryOrderId);
      const point = stop.coordinates ?? delivery?.coordinates ?? null;
      onTrip.add(stop.deliveryOrderId);
      if (!isUsablePoint(point)) continue;
      points.push({
        id: `stop:${stop.id}`,
        lat: point.lat,
        lng: point.lng,
        label: `${stop.sequence}. ${delivery?.customerName ?? delivery?.caseNumber ?? 'Entrega'}`,
        kind: 'stop',
        tripId: trip.id,
        sequence: stop.sequence,
        tone: stopStatusTone(stop.status),
        deliveryOrderId: stop.deliveryOrderId,
      });
    }
  }
  for (const delivery of deliveries) {
    if (onTrip.has(delivery.id) || !delivery.open) continue;
    if (!isUsablePoint(delivery.coordinates)) continue;
    points.push({
      id: `loose:${delivery.id}`,
      lat: delivery.coordinates.lat,
      lng: delivery.coordinates.lng,
      label: delivery.customerName ?? delivery.caseNumber ?? 'Entrega sin asignar',
      kind: 'loose',
      tripId: null,
      sequence: null,
      tone: 'weak',
      deliveryOrderId: delivery.id,
    });
  }
  return points;
}

/** Ordered polyline of every trip that has at least two located stops. */
export function buildTripLines(
  points: readonly MapPoint[]
): Array<{ tripId: string; positions: Array<[number, number]> }> {
  const byTrip = new Map<string, MapPoint[]>();
  for (const point of points) {
    if (point.kind !== 'stop' || !point.tripId) continue;
    const list = byTrip.get(point.tripId) ?? [];
    list.push(point);
    byTrip.set(point.tripId, list);
  }
  const lines: Array<{ tripId: string; positions: Array<[number, number]> }> = [];
  for (const [tripId, list] of byTrip) {
    if (list.length < 2) continue;
    const positions = [...list]
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((point): [number, number] => [point.lat, point.lng]);
    lines.push({ tripId, positions });
  }
  return lines;
}

/** Center and zoom that fit the markers (rough, enough for a city-wide board). */
export function fitMapView(points: readonly GeoPointDTO[]): { center: GeoPointDTO; zoom: number } {
  const usable = points.filter(isUsablePoint);
  if (usable.length === 0) return { center: DEFAULT_MAP_CENTER, zoom: DEFAULT_MAP_ZOOM };
  const lats = usable.map((point) => point.lat);
  const lngs = usable.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  const span = Math.max(maxLat - minLat, maxLng - minLng);
  const zoom =
    span === 0 ? 14 : span < 0.05 ? 13 : span < 0.15 ? 12 : span < 0.4 ? 11 : span < 1 ? 9 : 7;
  return { center, zoom };
}

/** Link that opens the turn-by-turn navigation of the phone. */
export function navigationUrl(
  point: GeoPointDTO | null,
  address: { line?: string | null; city?: string | null; state?: string | null } = {}
): string | null {
  if (isUsablePoint(point)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;
  }
  const text = [address.line, address.city, address.state].filter(Boolean).join(', ').trim();
  if (!text) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const LOGISTICS_TIMEZONE = 'America/Mexico_City';

function safeFormat(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: LOGISTICS_TIMEZONE }).format(
      date
    );
  } catch {
    return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: 'UTC' }).format(date);
  }
}

/** "14:30" of an ISO instant, or "—". */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return safeFormat(date, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "15 sep" of a day or an instant. */
export function formatDayLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return safeFormat(date, { day: 'numeric', month: 'short' }).replace('.', '');
}

/** "Ventana 09:00–13:00", "Desde 09:00", "Hasta 13:00" or null. */
export function formatWindow(start: string | null, end: string | null): string | null {
  if (start && end) return `Ventana ${formatTime(start)}–${formatTime(end)}`;
  if (start) return `Desde ${formatTime(start)}`;
  if (end) return `Hasta ${formatTime(end)}`;
  return null;
}

export interface EtaLabel {
  label: string;
  tone: AreaRowTone;
}

/** ETA of a stop compared with now and with the delivery window. */
export function formatEta(
  stop: Pick<DispatchStop, 'etaAt' | 'status' | 'arrivedAt' | 'departedAt'>,
  windowEnd: string | null,
  now: Date
): EtaLabel {
  if (stop.status === 'done')
    return { label: `Entregada ${formatTime(stop.departedAt ?? null)}`, tone: 'success' };
  if (stop.status === 'failed') return { label: 'No se pudo entregar', tone: 'danger' };
  if (stop.status === 'arrived')
    return { label: `En el sitio desde ${formatTime(stop.arrivedAt)}`, tone: 'info' };
  if (!stop.etaAt) return { label: 'Sin hora estimada', tone: 'default' };
  const eta = Date.parse(stop.etaAt);
  if (!Number.isFinite(eta)) return { label: 'Sin hora estimada', tone: 'default' };
  const limit = windowEnd ? Date.parse(windowEnd) : Number.NaN;
  if (Number.isFinite(limit) && eta > limit) {
    return { label: `Llega ${formatTime(stop.etaAt)} · fuera de ventana`, tone: 'danger' };
  }
  if (eta < now.getTime())
    return { label: `Debió llegar ${formatTime(stop.etaAt)}`, tone: 'warning' };
  return { label: `Llega ~${formatTime(stop.etaAt)}`, tone: 'default' };
}

/** `YYYY-MM-DD` of an instant in the operation's time zone. */
export function operationDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOGISTICS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Accepts only a real `YYYY-MM-DD`; anything else falls back to today. */
export function parseBoardDate(value: unknown, now: Date): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text) return text;
  }
  return operationDay(now);
}

/** Moves a board day by N days, keeping it a valid calendar day. */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Driver PWA
// ---------------------------------------------------------------------------

export type DriverStopState = 'next' | 'arrived' | 'waiting' | 'closed';

export interface DriverNextStop<T> {
  stop: T;
  state: Extract<DriverStopState, 'next' | 'arrived'>;
  /** Why this is the stop to work on now. */
  reason: string;
}

/**
 * The stop the driver has to work on: the one already arrived at, otherwise the
 * first pending one in sequence. Null when the trip has nothing open.
 */
export function pickDriverStop<T extends { status: string; sequence: number }>(
  stops: readonly T[]
): DriverNextStop<T> | null {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const arrived = ordered.find((stop) => stop.status === 'arrived');
  if (arrived) {
    return {
      stop: arrived,
      state: 'arrived',
      reason: 'Ya llegaste: registra la entrega o la incidencia',
    };
  }
  const pending = ordered.find((stop) => stop.status === 'pending');
  if (pending) return { stop: pending, state: 'next', reason: 'Es la siguiente parada de tu ruta' };
  return null;
}

export interface DeliveredLineInputValue {
  allocationId: string;
  /** What the driver typed (may be empty while editing). */
  value: string;
}

export type DeliveredLinesCheck =
  | { ok: true; lines: Array<{ allocationId: string; deliveredQty: number }>; short: boolean }
  | { ok: false; error: string };

/**
 * Quantities typed by the driver, validated with the same rules the engine
 * applies (`summarizeDelivery`): a number per line, never negative, never above
 * what the delivery still owes, and at least one line with something delivered.
 */
export function checkDeliveredLines(
  expected: readonly DeliveryLineDTO[],
  values: readonly DeliveredLineInputValue[]
): DeliveredLinesCheck {
  const byId = new Map(values.map((value) => [value.allocationId, value.value]));
  const lines: Array<{ allocationId: string; deliveredQty: number }> = [];
  let total = 0;
  let short = false;
  for (const line of expected) {
    const raw = (byId.get(line.allocationId) ?? '').trim();
    const quantity = raw === '' ? line.pendingQuantity : Number(raw);
    if (!Number.isFinite(quantity) || quantity < 0) {
      return {
        ok: false,
        error: `Revisa la cantidad de "${line.name}": debe ser un número igual o mayor que cero`,
      };
    }
    if (quantity > line.pendingQuantity + 0.00005) {
      return {
        ok: false,
        error:
          `No puedes entregar más de ${line.pendingQuantity} ${line.unit || ''} de "${line.name}"`.trim(),
      };
    }
    if (quantity < line.pendingQuantity - 0.00005) short = true;
    total += quantity;
    lines.push({ allocationId: line.allocationId, deliveredQty: quantity });
  }
  if (lines.length === 0) return { ok: false, error: 'La entrega no tiene líneas por registrar' };
  if (total <= 0) {
    return {
      ok: false,
      error:
        'No registraste ninguna cantidad entregada: usa "No se pudo entregar" si no dejaste nada',
    };
  }
  return { ok: true, lines, short };
}

export interface DeliveryFormState {
  receivedBy: string;
  evidenceCount: number;
  online: boolean;
}

/**
 * Why the delivery cannot be closed yet (null when it can). The engine demands
 * physical evidence of this attempt, and evidence only uploads with signal:
 * without it the delivery stays open instead of being rejected later.
 */
export function deliveryBlockReason(form: DeliveryFormState): string | null {
  if (!form.receivedBy.trim()) return 'Escribe quién recibió la mercancía';
  if (form.evidenceCount === 0) {
    return form.online
      ? 'Adjunta la foto de la entrega o la firma de quien recibe antes de cerrarla'
      : 'Sin conexión no se puede subir la foto ni la firma: registra "No se pudo entregar" o espera a tener señal';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command inputs (every action of the area)
// ---------------------------------------------------------------------------

const ORDER_AGGREGATE = LOGISTICS_OBJECT_TYPES.deliveryOrder;
const TRIP_AGGREGATE = LOGISTICS_OBJECT_TYPES.trip;

type CommandInput = OfflineCommandInput<Record<string, unknown>>;

export interface AssignTransportValues {
  carrier: string;
  date: string;
  trackingNumber?: string | null;
  vehicleId?: string | null;
  driverId?: string | null;
  /** `own_fleet` or `carrier`; omitted keeps the mode the delivery already has. */
  mode?: DeliveryMode | null;
}

export function assignTransportInput(
  order: Pick<DispatchDelivery, 'id' | 'version'>,
  values: AssignTransportValues
): CommandInput {
  const ownFleet = values.mode ? values.mode === 'own_fleet' : true;
  return {
    type: LOGISTICS_COMMANDS.deliveryAssignTransport,
    aggregate: { type: ORDER_AGGREGATE, id: order.id },
    expectedVersion: order.version,
    payload: {
      deliveryOrderId: order.id,
      carrier: values.carrier.trim(),
      date: values.date,
      trackingNumber: values.trackingNumber?.trim() || null,
      // A carrier shipment travels without a unit of ours: never send one.
      vehicleId: ownFleet ? values.vehicleId || null : null,
      driverId: ownFleet ? values.driverId || null : null,
      ...(values.mode ? { mode: values.mode } : {}),
    },
  };
}

export function cancelDeliveryInput(
  order: Pick<DispatchDelivery, 'id' | 'version'>,
  reason: string
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.deliveryCancel,
    aggregate: { type: ORDER_AGGREGATE, id: order.id },
    expectedVersion: order.version,
    payload: { deliveryOrderId: order.id, reason: reason.trim() },
  };
}

export function linkPackageInput(order: Pick<DispatchDelivery, 'id' | 'version'>): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.deliveryLinkPackage,
    aggregate: { type: ORDER_AGGREGATE, id: order.id },
    expectedVersion: order.version,
    payload: { deliveryOrderId: order.id },
  };
}

export interface BuildTripValues {
  date: string;
  vehicleId: string;
  driverId: string;
  deliveryOrderIds: string[];
  optimize: boolean;
  overrideCapacity: boolean;
  notes?: string;
  origin?: GeoPointDTO | null;
}

/** `trip.build` has no aggregate: its id is the natural key of the day + vehicle. */
export function buildTripInput(values: BuildTripValues): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripBuild,
    aggregate: { type: TRIP_AGGREGATE, id: `trip:${values.vehicleId}:${values.date}` },
    payload: {
      date: values.date,
      vehicleId: values.vehicleId,
      driverId: values.driverId,
      deliveryOrderIds: [...new Set(values.deliveryOrderIds)],
      optimize: values.optimize,
      overrideCapacity: values.overrideCapacity,
      ...(values.notes?.trim() ? { notes: values.notes.trim() } : {}),
      ...(isUsablePoint(values.origin ?? null) ? { origin: values.origin } : {}),
    },
  };
}

export function addStopInput(
  trip: Pick<DispatchTrip, 'id' | 'version'>,
  deliveryOrderId: string,
  overrideCapacity = false
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripAddStop,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: { deliveryOrderId, overrideCapacity },
  };
}

export function reorderStopsInput(
  trip: Pick<DispatchTrip, 'id' | 'version'>,
  stopIds: readonly string[]
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripReorder,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: { stopIds: [...stopIds] },
  };
}

export function startTripInput(trip: Pick<DispatchTrip, 'id' | 'version'>): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripStart,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: {},
  };
}

export function closeTripInput(trip: Pick<DispatchTrip, 'id' | 'version'>): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripClose,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: {},
  };
}

/** The trip that is not going to run: its deliveries go back to Despacho. */
export function cancelTripInput(
  trip: Pick<DispatchTrip, 'id' | 'version'>,
  reason: string
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripCancel,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: { reason: reason.trim() },
  };
}

export function arriveStopInput(
  trip: Pick<DispatchTrip, 'id' | 'version'>,
  stopId: string,
  coordinates: GeoPointDTO | null
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripArriveStop,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: {
      stopId,
      ...(isUsablePoint(coordinates) ? { lat: coordinates.lat, lng: coordinates.lng } : {}),
    },
  };
}

export interface CompleteStopValues {
  lines: Array<{ allocationId: string; deliveredQty: number }>;
  receivedBy: string;
  evidenceObjectIds: string[];
  note?: string;
  partialReason?: string;
  coordinates?: GeoPointDTO | null;
}

export function completeStopInput(
  trip: Pick<DispatchTrip, 'id' | 'version'>,
  stopId: string,
  values: CompleteStopValues
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripCompleteStop,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: {
      stopId,
      lines: values.lines,
      receivedBy: values.receivedBy.trim(),
      evidenceObjectIds: values.evidenceObjectIds,
      ...(values.note?.trim() ? { note: values.note.trim() } : {}),
      ...(values.partialReason?.trim() ? { partialReason: values.partialReason.trim() } : {}),
      ...(isUsablePoint(values.coordinates ?? null)
        ? { lat: values.coordinates?.lat, lng: values.coordinates?.lng }
        : {}),
    },
  };
}

export function failStopInput(
  trip: Pick<DispatchTrip, 'id' | 'version'>,
  stopId: string,
  reason: string,
  coordinates: GeoPointDTO | null
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.tripFailStop,
    aggregate: { type: TRIP_AGGREGATE, id: trip.id },
    expectedVersion: trip.version,
    payload: {
      stopId,
      reason: reason.trim(),
      ...(isUsablePoint(coordinates) ? { lat: coordinates.lat, lng: coordinates.lng } : {}),
    },
  };
}

/** A delivery not on a trip is recorded against the delivery order itself. */
export function recordDeliveryInput(
  order: Pick<DispatchDelivery, 'id' | 'version'>,
  values: CompleteStopValues
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.deliveryRecord,
    aggregate: { type: ORDER_AGGREGATE, id: order.id },
    expectedVersion: order.version,
    payload: {
      deliveryOrderId: order.id,
      lines: values.lines,
      receivedBy: values.receivedBy.trim(),
      evidenceObjectIds: values.evidenceObjectIds,
      ...(values.note?.trim() ? { note: values.note.trim() } : {}),
      ...(values.partialReason?.trim() ? { partialReason: values.partialReason.trim() } : {}),
      ...(isUsablePoint(values.coordinates ?? null)
        ? { lat: values.coordinates?.lat, lng: values.coordinates?.lng }
        : {}),
    },
  };
}

export interface VehicleFormValues {
  code: string;
  plate: string;
  label: string;
  capacityKg?: number | null;
  capacityM2?: number | null;
  capacityPieces?: number | null;
  maintenanceUntil?: string | null;
  active?: boolean;
}

export function createVehicleInput(values: VehicleFormValues): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.fleetVehicleCreate,
    aggregate: {
      type: LOGISTICS_OBJECT_TYPES.vehicle,
      id: `vehicle:${normalizeVehicleCode(values.code)}`,
    },
    payload: vehiclePayload(values),
  };
}

export function updateVehicleInput(
  vehicleId: string,
  values: Partial<VehicleFormValues>
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.fleetVehicleUpdate,
    aggregate: { type: LOGISTICS_OBJECT_TYPES.vehicle, id: vehicleId },
    payload: { vehicleId, ...vehiclePayload(values) },
  };
}

function vehiclePayload(values: Partial<VehicleFormValues>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (values.code !== undefined) payload.code = values.code.trim();
  if (values.plate !== undefined) payload.plate = values.plate.trim();
  if (values.label !== undefined) payload.label = values.label.trim();
  if (values.capacityKg !== undefined) payload.capacityKg = values.capacityKg;
  if (values.capacityM2 !== undefined) payload.capacityM2 = values.capacityM2;
  if (values.capacityPieces !== undefined) payload.capacityPieces = values.capacityPieces;
  if (values.maintenanceUntil !== undefined)
    payload.maintenanceUntil = values.maintenanceUntil || null;
  if (values.active !== undefined) payload.active = values.active;
  return payload;
}

export interface DriverFormValues {
  name: string;
  phone?: string | null;
  licenseNumber?: string | null;
  userId?: string | null;
  active?: boolean;
}

export function createDriverInput(values: DriverFormValues): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.fleetDriverCreate,
    aggregate: {
      type: LOGISTICS_OBJECT_TYPES.driver,
      id: `driver:${values.userId || values.name.trim()}`,
    },
    payload: driverPayload(values),
  };
}

export function updateDriverInput(
  driverId: string,
  values: Partial<DriverFormValues>
): CommandInput {
  return {
    type: LOGISTICS_COMMANDS.fleetDriverUpdate,
    aggregate: { type: LOGISTICS_OBJECT_TYPES.driver, id: driverId },
    payload: { driverId, ...driverPayload(values) },
  };
}

function driverPayload(values: Partial<DriverFormValues>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (values.name !== undefined) payload.name = values.name.trim();
  if (values.phone !== undefined) payload.phone = values.phone?.trim() || null;
  if (values.licenseNumber !== undefined)
    payload.licenseNumber = values.licenseNumber?.trim() || null;
  if (values.userId !== undefined) payload.userId = values.userId || null;
  if (values.active !== undefined) payload.active = values.active;
  return payload;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const LOGISTICS_AREA_KEY = 'logistica';
export const DISPATCH_PATH = `/app/areas/${LOGISTICS_AREA_KEY}/despacho`;
export const TRIPS_PATH = `/app/areas/${LOGISTICS_AREA_KEY}/viajes`;
export const FLEET_PATH = `/app/areas/${LOGISTICS_AREA_KEY}/flota`;
export const DRIVER_PATH = `/app/areas/${LOGISTICS_AREA_KEY}/chofer`;
export const LOGISTICS_WORK_PATH = `/app/areas/${LOGISTICS_AREA_KEY}/trabajo`;

export function tripHref(tripId: string): string {
  return `${TRIPS_PATH}/${encodeURIComponent(tripId)}`;
}

export function dispatchHref(params: { date?: string; delivery?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.date) search.set('fecha', params.date);
  if (params.delivery) search.set('entrega', params.delivery);
  const query = search.toString();
  return query ? `${DISPATCH_PATH}?${query}` : DISPATCH_PATH;
}

/** Read APIs of the area (all under the area gate). */
export const LOGISTICS_API = {
  board: (date: string) =>
    `/app/areas/${LOGISTICS_AREA_KEY}/api/logistica/despacho?fecha=${encodeURIComponent(date)}`,
  trip: (tripId: string) =>
    `/app/areas/${LOGISTICS_AREA_KEY}/api/logistica/viajes/${encodeURIComponent(tripId)}`,
  fleet: (date: string) =>
    `/app/areas/${LOGISTICS_AREA_KEY}/api/logistica/flota?fecha=${encodeURIComponent(date)}`,
  driverToday: (date?: string) =>
    date
      ? `/app/areas/${LOGISTICS_AREA_KEY}/chofer/api/today?fecha=${encodeURIComponent(date)}`
      : `/app/areas/${LOGISTICS_AREA_KEY}/chofer/api/today`,
  driverCommands: `/app/areas/${LOGISTICS_AREA_KEY}/chofer/api/commands`,
} as const;

/** Realtime channels of the area surfaces. */
export const DISPATCH_CHANNEL = 'logistics:dispatch';
export const LOGISTICS_REALTIME_TYPES = [
  'logistics.deliveries',
  'logistics.trips',
  'logistics.fleet',
] as const;
export function tripChannel(tripId: string): string {
  return `trip:${tripId}`;
}

/**
 * Delivery modes offered when assigning transport that writes to Zoho: own
 * fleet (unit + driver of ours) or an external carrier (a courier, with its
 * tracking number and no unit). Same list the engine validates
 * (`SHIPPING_MODES`), so the dialog can never offer a mode it would reject.
 */
export const SHIPPING_MODE_KEYS: readonly DeliveryMode[] = SHIPPING_MODES;

export interface ShippingModeOption {
  value: DeliveryMode;
  label: string;
}

export function shippingModeOptions(): ShippingModeOption[] {
  return SHIPPING_MODE_KEYS.map((value) => ({ value, label: deliveryModeLabel(value) }));
}
