'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Alert, Button, FormField, Select } from '@/components/ui/primitives';
import { consolidatePurchaseRequestAction } from './compras-actions';

interface RequestLine {
  id: string;
  description: string;
  qty: string;
  qtyOrdered: string;
  unit: string;
  status: string;
  statusLabel: string;
}
interface RequestView {
  id: string;
  number: string;
  statusLabel: string;
  lines: RequestLine[];
}
interface SupplierRow {
  id: string;
  name: string;
  number: string;
}

export interface PurchaseRequestConsolidationPanelProps {
  areaKey: string;
  requestId: string;
  canAct: boolean;
}

/** Turns selected, still-open request lines into the RFQ or purchase order command. */
export function PurchaseRequestConsolidationPanel({
  areaKey,
  requestId,
  canAct,
}: PurchaseRequestConsolidationPanelProps) {
  const [request, setRequest] = useState<RequestView | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [selected, setSelected] = useState<string[]>([]);
  const [into, setInto] = useState<'rfq' | 'order'>('rfq');
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const [requestResponse, suppliersResponse] = await Promise.all([
        fetch(
          `/app/areas/${encodeURIComponent(areaKey)}/api/compras/requests/${encodeURIComponent(requestId)}`,
          { headers: { accept: 'application/json' } }
        ),
        fetch(`/app/areas/${encodeURIComponent(areaKey)}/api/compras/suppliers?pageSize=100`, {
          headers: { accept: 'application/json' },
        }),
      ]);
      if (!requestResponse.ok || !suppliersResponse.ok) throw new Error('request_fetch_failed');
      const requestBody = (await requestResponse.json()) as { request: RequestView };
      const supplierBody = (await suppliersResponse.json()) as { suppliers: SupplierRow[] };
      setRequest(requestBody.request);
      setSuppliers(supplierBody.suppliers);
      setSelected((current) =>
        current.filter((id) => requestBody.request.lines.some((line) => line.id === id))
      );
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, requestId]);

  useEffect(() => {
    void load();
  }, [load]);
  const orderable = useMemo(
    () =>
      request?.lines.filter((line) => ['open', 'partially_ordered'].includes(line.status)) ?? [],
    [request]
  );

  function toggle(lineId: string) {
    setSelected((current) =>
      current.includes(lineId) ? current.filter((id) => id !== lineId) : [...current, lineId]
    );
  }
  function submit() {
    if (!request) return;
    if (selected.length < 2) {
      setError('Selecciona al menos dos partidas para consolidar');
      return;
    }
    if (into === 'order' && !supplierId) {
      setError('Elige el proveedor para crear una orden');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await consolidatePurchaseRequestAction({
        requestId: request.id,
        lineIds: selected,
        into,
        ...(into === 'order' ? { supplierId } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success(`${result.data.number} creada con ${result.data.lines} partida(s)`);
      setSelected([]);
      await load();
    });
  }

  if (state === 'loading')
    return <LoadingState variant="list" rows={3} label="Cargando solicitud…" />;
  if (state === 'failed' || !request)
    return (
      <ErrorState
        title="No pudimos abrir la solicitud"
        message="Recarga la página e inténtalo de nuevo."
      />
    );
  return (
    <section className="area-drawer-section" aria-labelledby="request-consolidation">
      <h3 id="request-consolidation" className="area-drawer-section-title">
        Consolidar solicitud
      </h3>
      <p className="area-row-sub">
        {request.number} · {request.statusLabel}. Se crean documentos formales, no sólo una
        agrupación visual.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {!canAct ? (
        <p className="area-row-sub">
          Puedes consultar las partidas; Compras las consolida cuando corresponda.
        </p>
      ) : null}
      {canAct ? (
        <>
          {orderable.length === 0 ? (
            <Alert variant="info">No hay dos partidas abiertas que se puedan consolidar.</Alert>
          ) : (
            <div className="compras-response-form">
              {orderable.map((line) => (
                <label className="flex items-center gap-2" key={line.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(line.id)}
                    disabled={pending}
                    onChange={() => toggle(line.id)}
                  />
                  <span>
                    {line.description} · faltan{' '}
                    {Math.max(0, Number(line.qty) - Number(line.qtyOrdered))} {line.unit}
                  </span>
                </label>
              ))}
              <FormField label="Crear" htmlFor={`consolidate-into-${request.id}`}>
                <Select
                  id={`consolidate-into-${request.id}`}
                  value={into}
                  disabled={pending}
                  onChange={(event) => setInto(event.target.value as typeof into)}
                >
                  <option value="rfq">Cotización (RFQ)</option>
                  <option value="order">Orden de compra</option>
                </Select>
              </FormField>
              {into === 'order' ? (
                <FormField label="Proveedor" htmlFor={`consolidate-supplier-${request.id}`}>
                  <Select
                    id={`consolidate-supplier-${request.id}`}
                    value={supplierId}
                    disabled={pending}
                    onChange={(event) => setSupplierId(event.target.value)}
                  >
                    <option value="">Elige un proveedor</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.number} · {supplier.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              ) : null}
              <div className="area-drawer-actions">
                <Button size="sm" disabled={pending || selected.length < 2} onClick={submit}>
                  {pending ? 'Consolidando…' : 'Consolidar partidas seleccionadas'}
                </Button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
