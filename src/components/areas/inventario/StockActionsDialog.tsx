'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  claimLegacyStockAction,
  recordStockActionAction,
} from '@/app/app/areas/inventario/actions';
import { LoadingState } from '@/components/patterns/LoadingState';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, FormField, Input, Select, Textarea } from '@/components/ui/primitives';
import type { ItemStockForCapture } from '@/modules/areas/inventario/inventory-area-queries';
import {
  DECISION_NOTE_MAX,
  LEGACY_SOURCE_OPTIONS,
  STOCK_ACTION_HINTS,
  STOCK_ACTION_KINDS,
  STOCK_ACTION_LABELS,
  buildLegacyClaim,
  buildStockAction,
  emptyLegacyClaimForm,
  emptyStockActionForm,
  formatQty,
  stockActionNeedsAdjustPermission,
  stockActionNeedsDestination,
  stockActionNeedsReason,
  stockActionNeedsStockItem,
  type LegacyClaimFormValues,
  type StockActionFormValues,
  type StockActionKind,
} from './inventario-model';

/**
 * Captura de un movimiento (entrada, salida, devolución, traspaso, ajuste,
 * bloqueo y desbloqueo) y de un compromiso previo al corte, sobre UN artículo.
 *
 * Es lo que faltaba del plan §3.3: `recordInventoryMovement` y
 * `claimLegacyCommitment` existían y ninguna pantalla los llamaba, así que la
 * subpágina «Movimientos» era un libro de sólo lectura de lo que escriben
 * Compras y Manufactura, y todo lo prometido antes del corte se prometía dos
 * veces.
 *
 * Las filas de la existencia (bodega, ubicación, variante, contenedor) las trae
 * el mismo `getStockSnapshot` que ya usan el perfil y la IA; el motor vuelve a
 * validar permiso, unidades y saldos dentro de la transacción.
 */

export interface StockActionsDialogProps {
  areaKey: string;
  item: { zohoItemId: string; name: string; baseUnit: string };
  /** Warehouse already chosen in the table filter, when there is one. */
  defaultWarehouseId?: string | null;
  onClose: () => void;
  /** Something changed in the warehouse: the table reloads. */
  onDone: () => void;
}

type Mode = 'movement' | 'claim';

interface StockPayload {
  stock: ItemStockForCapture;
  can: { move: boolean; adjust: boolean; claim: boolean };
}

export function StockActionsDialog({
  areaKey,
  item,
  defaultWarehouseId,
  onClose,
  onDone,
}: StockActionsDialogProps) {
  const [payload, setPayload] = useState<StockPayload | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [mode, setMode] = useState<Mode>('movement');
  const [form, setForm] = useState<StockActionFormValues>(() =>
    emptyStockActionForm({
      zohoItemId: item.zohoItemId,
      warehouseId: defaultWarehouseId ?? '',
      unit: item.baseUnit,
    })
  );
  const [claimForm, setClaimForm] = useState<LegacyClaimFormValues>(() =>
    emptyLegacyClaimForm({
      zohoItemId: item.zohoItemId,
      warehouseId: defaultWarehouseId ?? '',
      unit: item.baseUnit,
    })
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/inventario/stock/${encodeURIComponent(item.zohoItemId)}`,
        { headers: { accept: 'application/json' } }
      );
      const body = (await response.json().catch(() => ({}))) as Partial<StockPayload> & {
        error?: string;
      };
      if (!response.ok || !body.stock) throw new Error(body.error ?? 'stock_fetch_failed');
      const data = body as StockPayload;
      setPayload(data);
      const warehouseId =
        defaultWarehouseId ||
        data.stock.items[0]?.warehouseId ||
        data.stock.warehouses[0]?.id ||
        '';
      setForm((current) => ({
        ...current,
        warehouseId: current.warehouseId || warehouseId,
        unit: current.unit || data.stock.baseUnit,
      }));
      setClaimForm((current) => ({
        ...current,
        warehouseId: current.warehouseId || warehouseId,
        unit: current.unit || data.stock.baseUnit,
      }));
      // Quien sólo puede reservar abre directo en el compromiso: ofrecerle
      // primero un formulario que no puede enviar sería una puerta cerrada.
      if (!data.can.move && !data.can.adjust && data.can.claim) setMode('claim');
      setState('ready');
    } catch (err) {
      setError(err instanceof Error && err.message !== 'stock_fetch_failed' ? err.message : null);
      setState('failed');
    }
  }, [areaKey, defaultWarehouseId, item.zohoItemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = payload?.stock.items;
  const rows = useMemo(() => items ?? [], [items]);
  const warehouses = payload?.stock.warehouses ?? [];
  const can = payload?.can ?? { move: false, adjust: false, claim: false };

  const kinds = useMemo(
    () =>
      STOCK_ACTION_KINDS.filter((kind) =>
        stockActionNeedsAdjustPermission(kind) ? can.adjust : can.move
      ),
    [can.adjust, can.move]
  );

  // The chosen kind must stay inside what this person may do.
  useEffect(() => {
    if (kinds.length > 0 && !kinds.includes(form.kind)) {
      setForm((current) => ({ ...current, kind: kinds[0] as StockActionKind }));
    }
  }, [form.kind, kinds]);

  const rowsOfWarehouse = useMemo(
    () => rows.filter((row) => !form.warehouseId || row.warehouseId === form.warehouseId),
    [rows, form.warehouseId]
  );

  function patch(values: Partial<StockActionFormValues>) {
    setForm((current) => ({ ...current, ...values }));
  }

  function submitMovement() {
    const input = buildStockAction(form);
    if (!input.ok) {
      setError(input.error);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await recordStockActionAction(input.value);
      if (result.ok) {
        toast.success(result.message);
        onDone();
        onClose();
      } else {
        setError(result.error);
        toast.error(result.error);
      }
    });
  }

  function submitClaim() {
    const input = buildLegacyClaim(claimForm);
    if (!input.ok) {
      setError(input.error);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await claimLegacyStockAction(input.value);
      if (result.ok) {
        toast.success(result.message);
        onDone();
        onClose();
      } else {
        setError(result.error);
        toast.error(result.error);
      }
    });
  }

  const needsRow = stockActionNeedsStockItem(form.kind);
  const needsDestination = stockActionNeedsDestination(form.kind);
  const needsReason = stockActionNeedsReason(form.kind);

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {payload
              ? `Conocido ${formatQty(payload.stock.totals.known, payload.stock.baseUnit)} · disponible ${formatQty(payload.stock.totals.available, payload.stock.baseUnit)} · bloqueado ${formatQty(payload.stock.totals.blocked, payload.stock.baseUnit)}`
              : 'Movimientos y compromisos de esta existencia'}
          </DialogDescription>
        </DialogHeader>

        {state === 'loading' ? (
          <LoadingState variant="list" rows={3} label="Cargando la existencia…" />
        ) : state === 'failed' ? (
          <Alert variant="error">
            {error ?? 'No pudimos cargar la existencia. Vuelve a intentarlo.'}
          </Alert>
        ) : (
          <div className="inv-form">
            {error ? <Alert variant="error">{error}</Alert> : null}

            {can.claim ? (
              <div className="inv-capture-actions" role="tablist" aria-label="Qué vas a registrar">
                <Button
                  size="sm"
                  variant={mode === 'movement' ? 'primary' : 'secondary'}
                  role="tab"
                  aria-selected={mode === 'movement'}
                  onClick={() => setMode('movement')}
                >
                  Movimiento
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'claim' ? 'primary' : 'secondary'}
                  role="tab"
                  aria-selected={mode === 'claim'}
                  onClick={() => setMode('claim')}
                >
                  Compromiso previo al corte
                </Button>
              </div>
            ) : null}

            {mode === 'movement' ? (
              kinds.length === 0 ? (
                <Alert variant="info">
                  Registrar movimientos necesita el permiso de gestionar inventario; ajustar y
                  bloquear, el de ajustar.
                </Alert>
              ) : (
                <div className="inv-form-grid">
                  <FormField label="Qué registras" htmlFor="inv-action-kind">
                    <Select
                      id="inv-action-kind"
                      value={form.kind}
                      onChange={(event) =>
                        patch({ kind: event.target.value as StockActionKind, stockItemId: '' })
                      }
                    >
                      {kinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {STOCK_ACTION_LABELS[kind]}
                        </option>
                      ))}
                    </Select>
                  </FormField>

                  <FormField label="Bodega" htmlFor="inv-action-warehouse">
                    <Select
                      id="inv-action-warehouse"
                      value={form.warehouseId}
                      onChange={(event) =>
                        patch({ warehouseId: event.target.value, stockItemId: '' })
                      }
                    >
                      <option value="">Elige la bodega…</option>
                      {warehouses.map((warehouse) => (
                        <option key={warehouse.id} value={warehouse.id}>
                          {warehouse.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>

                  <FormField
                    label={needsRow ? 'Existencia' : 'Existencia (opcional)'}
                    htmlFor="inv-action-row"
                    help={
                      needsRow
                        ? 'Bloquear y desbloquear actúan sobre una fila concreta.'
                        : 'Vacío deja que el motor use o cree la fila de la ubicación.'
                    }
                  >
                    <Select
                      id="inv-action-row"
                      value={form.stockItemId}
                      onChange={(event) => patch({ stockItemId: event.target.value })}
                    >
                      <option value="">{needsRow ? 'Elige la existencia…' : 'Sin elegir'}</option>
                      {rowsOfWarehouse.map((row) => (
                        <option key={row.id} value={row.id}>
                          {[row.locationCode ?? 'Sin ubicación', row.variantLabel, row.containerKey]
                            .filter(Boolean)
                            .join(' · ')}{' '}
                          — {formatQty(row.known)} ({formatQty(row.blocked)} bloqueado)
                        </option>
                      ))}
                    </Select>
                  </FormField>

                  {/* Con una fila elegida el motor usa SU ubicación: pedir otra
                      aquí sería una promesa que el comando no cumple. */}
                  {!needsRow && !form.stockItemId ? (
                    <FormField
                      label="Ubicación (opcional)"
                      htmlFor="inv-action-location"
                      help="Código de la ubicación; vacío usa GENERAL."
                    >
                      <Input
                        id="inv-action-location"
                        value={form.locationCode}
                        maxLength={40}
                        autoComplete="off"
                        onChange={(event) => patch({ locationCode: event.target.value })}
                      />
                    </FormField>
                  ) : null}

                  {needsDestination ? (
                    <>
                      <FormField label="Bodega de destino" htmlFor="inv-action-to-warehouse">
                        <Select
                          id="inv-action-to-warehouse"
                          value={form.toWarehouseId}
                          onChange={(event) => patch({ toWarehouseId: event.target.value })}
                        >
                          <option value="">Elige la bodega…</option>
                          {warehouses.map((warehouse) => (
                            <option key={warehouse.id} value={warehouse.id}>
                              {warehouse.name}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <FormField
                        label="Ubicación de destino (opcional)"
                        htmlFor="inv-action-to-location"
                      >
                        <Input
                          id="inv-action-to-location"
                          value={form.toLocationCode}
                          maxLength={40}
                          autoComplete="off"
                          onChange={(event) => patch({ toLocationCode: event.target.value })}
                        />
                      </FormField>
                    </>
                  ) : null}

                  <FormField
                    label="Cantidad"
                    htmlFor="inv-action-qty"
                    help={
                      form.kind === 'adjust'
                        ? 'Con signo: negativa resta del libro, positiva suma. Nunca cero.'
                        : 'Siempre mayor que cero.'
                    }
                  >
                    <Input
                      id="inv-action-qty"
                      value={form.quantity}
                      inputMode="decimal"
                      autoComplete="off"
                      onChange={(event) => patch({ quantity: event.target.value })}
                    />
                  </FormField>

                  <FormField
                    label="Unidad"
                    htmlFor="inv-action-unit"
                    help="Vacío usa la unidad base del artículo."
                  >
                    <Input
                      id="inv-action-unit"
                      value={form.unit}
                      maxLength={30}
                      autoComplete="off"
                      onChange={(event) => patch({ unit: event.target.value })}
                    />
                  </FormField>

                  <FormField
                    label={needsReason ? 'Motivo' : 'Nota (opcional)'}
                    htmlFor="inv-action-reason"
                    help={STOCK_ACTION_HINTS[form.kind]}
                  >
                    <Textarea
                      id="inv-action-reason"
                      value={form.reason}
                      rows={2}
                      maxLength={DECISION_NOTE_MAX}
                      onChange={(event) => patch({ reason: event.target.value })}
                    />
                  </FormField>

                  <FormField
                    label="Referencia (opcional)"
                    htmlFor="inv-action-reference"
                    help="Orden, remisión o acuerdo que respalda el movimiento."
                  >
                    <Input
                      id="inv-action-reference"
                      value={form.reference}
                      maxLength={120}
                      autoComplete="off"
                      onChange={(event) => patch({ reference: event.target.value })}
                    />
                  </FormField>
                </div>
              )
            ) : (
              <div className="inv-form-grid">
                <Alert variant="info">
                  Lo prometido antes del corte resta del disponible hasta que se confirme contra un
                  expediente o se libere. Si nadie lo confirma, el supervisor lo expira.
                </Alert>

                <FormField label="Bodega comprometida" htmlFor="inv-claim-warehouse">
                  <Select
                    id="inv-claim-warehouse"
                    value={claimForm.warehouseId}
                    onChange={(event) =>
                      setClaimForm((current) => ({ ...current, warehouseId: event.target.value }))
                    }
                  >
                    <option value="">Elige la bodega…</option>
                    {warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {warehouse.name}
                      </option>
                    ))}
                  </Select>
                </FormField>

                <FormField label="Cantidad comprometida" htmlFor="inv-claim-qty">
                  <Input
                    id="inv-claim-qty"
                    value={claimForm.quantity}
                    inputMode="decimal"
                    autoComplete="off"
                    onChange={(event) =>
                      setClaimForm((current) => ({ ...current, quantity: event.target.value }))
                    }
                  />
                </FormField>

                <FormField label="Unidad" htmlFor="inv-claim-unit">
                  <Input
                    id="inv-claim-unit"
                    value={claimForm.unit}
                    maxLength={30}
                    autoComplete="off"
                    onChange={(event) =>
                      setClaimForm((current) => ({ ...current, unit: event.target.value }))
                    }
                  />
                </FormField>

                <FormField label="De dónde viene" htmlFor="inv-claim-source">
                  <Select
                    id="inv-claim-source"
                    value={claimForm.source}
                    onChange={(event) =>
                      setClaimForm((current) => ({ ...current, source: event.target.value }))
                    }
                  >
                    {LEGACY_SOURCE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </FormField>

                <FormField
                  label="Referencia"
                  htmlFor="inv-claim-reference"
                  help="Número de orden anterior, cliente o acuerdo: es lo que permite reconocerlo después."
                >
                  <Input
                    id="inv-claim-reference"
                    value={claimForm.reference}
                    maxLength={200}
                    autoComplete="off"
                    onChange={(event) =>
                      setClaimForm((current) => ({ ...current, reference: event.target.value }))
                    }
                  />
                </FormField>

                <FormField label="Nota (opcional)" htmlFor="inv-claim-note">
                  <Textarea
                    id="inv-claim-note"
                    value={claimForm.note}
                    rows={2}
                    maxLength={DECISION_NOTE_MAX}
                    onChange={(event) =>
                      setClaimForm((current) => ({ ...current, note: event.target.value }))
                    }
                  />
                </FormField>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          {state === 'ready' && mode === 'movement' && kinds.length > 0 ? (
            <Button size="sm" onClick={submitMovement} isLoading={pending} disabled={pending}>
              Registrar {STOCK_ACTION_LABELS[form.kind].toLowerCase()}
            </Button>
          ) : null}
          {state === 'ready' && mode === 'claim' ? (
            <Button size="sm" onClick={submitClaim} isLoading={pending} disabled={pending}>
              Registrar compromiso
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
