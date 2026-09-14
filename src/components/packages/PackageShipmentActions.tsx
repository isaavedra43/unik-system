'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Pencil, Truck, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import type { PackageDetail } from '@/modules/packages/packages-contract';

interface Props {
  pkg: PackageDetail;
  basePath: string;
  canShip: boolean;
  canEdit: boolean;
  onUpdated: (pkg: PackageDetail) => void;
}

type ShipForm = {
  carrier: string;
  date: string;
  trackingNumber: string;
  trackingUrl: string;
  shippingCharge: string;
  notes: string;
  delivered: boolean;
  deliveryDate: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

async function call(url: string, init: RequestInit): Promise<PackageDetail> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const json = (await res.json().catch(() => null)) as (PackageDetail & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error ?? `Error ${res.status}`);
  return json;
}

/**
 * Shipping flow of a package, written to Zoho and read back:
 * assign carrier (creates the shipment order NE-xxxxx), edit it, mark delivered, cancel it,
 * and edit the package's own date / notes.
 */
export function PackageShipmentActions({ pkg, basePath, canShip, canEdit, onUpdated }: Props) {
  const shipped = Boolean(pkg.zohoShipmentId || pkg.shipmentNumber);
  const delivered = (pkg.status ?? '').toLowerCase() === 'delivered' || Boolean(pkg.deliveryDate);
  const [dialog, setDialog] = useState<'ship' | 'deliver' | 'cancel' | 'edit' | null>(null);
  const [busy, setBusy] = useState(false);
  const [carriers, setCarriers] = useState<string[]>([]);
  const [form, setForm] = useState<ShipForm>(() => ({
    carrier: pkg.carrier ?? '',
    date: day(pkg.shipmentDate) || today(),
    trackingNumber: pkg.trackingNumber ?? '',
    trackingUrl: pkg.trackingUrl ?? '',
    shippingCharge: pkg.shippingCharge ?? '',
    notes: pkg.notes ?? '',
    delivered: false,
    deliveryDate: today(),
  }));
  const [deliveredDate, setDeliveredDate] = useState(today());
  const [edit, setEdit] = useState({ date: day(pkg.date), notes: pkg.notes ?? '' });

  useEffect(() => {
    if (dialog !== 'ship' || carriers.length) return;
    fetch(`${basePath}/carriers`)
      .then((r) => (r.ok ? r.json() : { carriers: [] }))
      .then((j: { carriers?: string[] }) => setCarriers(j.carriers ?? []))
      .catch(() => undefined);
  }, [dialog, basePath, carriers.length]);

  const url = `${basePath}/${pkg.id}`;
  const run = async (label: string, fn: () => Promise<PackageDetail>) => {
    setBusy(true);
    try {
      const updated = await fn();
      toast.success(label);
      setDialog(null);
      onUpdated(updated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  };

  const submitShip = () =>
    run(shipped ? 'Orden de envío actualizada en Zoho' : 'Paquete enviado: orden de envío creada en Zoho', () =>
      call(`${url}/shipment`, {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          shippingCharge: form.shippingCharge === '' ? null : Number(form.shippingCharge),
          delivered: !shipped && form.delivered,
        }),
      })
    );
  const submitDeliver = () =>
    run('Paquete marcado como entregado en Zoho', () => call(`${url}/shipment/delivered`, { method: 'POST', body: JSON.stringify({ deliveredDate }) }));
  const submitCancel = () => run('Orden de envío eliminada en Zoho', () => call(`${url}/shipment`, { method: 'DELETE' }));
  const submitEdit = () => run('Paquete actualizado en Zoho', () => call(`${url}/edit`, { method: 'PATCH', body: JSON.stringify(edit) }));

  if (!canShip && !canEdit) return null;

  return (
    <div className="pkg-ship-actions">
      {canShip ? (
        <>
          {!delivered ? (
            <button type="button" className={`btn btn-sm ${shipped ? 'btn-secondary' : 'btn-primary'}`} onClick={() => setDialog('ship')}>
              <Truck size={14} aria-hidden="true" /> {shipped ? 'Editar envío' : 'Enviar · asignar transportista'}
            </button>
          ) : null}
          {shipped && !delivered ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('deliver')}>
              <CheckCircle2 size={14} aria-hidden="true" /> Marcar entregado
            </button>
          ) : null}
          {shipped ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('cancel')}>
              <Undo2 size={14} aria-hidden="true" /> Cancelar envío
            </button>
          ) : null}
        </>
      ) : null}
      {canEdit ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('edit')}>
          <Pencil size={14} aria-hidden="true" /> Editar paquete
        </button>
      ) : null}

      <Dialog open={dialog === 'ship'} onOpenChange={(v) => !v && !busy && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{shipped ? `Editar orden de envío ${pkg.shipmentNumber ?? ''}` : `Enviar ${pkg.packageNumber ?? 'paquete'}`}</DialogTitle>
            <DialogDescription>
              {shipped ? 'Los cambios se guardan en la orden de envío de Zoho.' : 'Se crea la orden de envío en Zoho (NE-xxxxx) con el transportista elegido.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="pkg-ship-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitShip();
            }}
          >
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="ship-carrier">Transportista *</label>
                <input
                  id="ship-carrier"
                  className="input"
                  list="ship-carrier-options"
                  required
                  value={form.carrier}
                  onChange={(e) => setForm({ ...form, carrier: e.target.value })}
                  placeholder="Elige o escribe el nombre"
                  autoComplete="off"
                />
                <datalist id="ship-carrier-options">
                  {carriers.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <span className="form-help">Debe coincidir con el transportista configurado en Zoho.</span>
              </div>
              <div className="form-field">
                <label htmlFor="ship-date">Fecha de envío *</label>
                <input id="ship-date" type="date" className="input" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="form-field">
                <label htmlFor="ship-tracking">N.º de seguimiento</label>
                <input id="ship-tracking" className="input" value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} />
              </div>
              <div className="form-field">
                <label htmlFor="ship-url">URL de seguimiento</label>
                <input id="ship-url" type="url" className="input" value={form.trackingUrl} onChange={(e) => setForm({ ...form, trackingUrl: e.target.value })} placeholder="https://" />
              </div>
              <div className="form-field">
                <label htmlFor="ship-charge">Cargos de envío (MXN)</label>
                <input id="ship-charge" type="number" min="0" step="0.01" className="input" value={form.shippingCharge} onChange={(e) => setForm({ ...form, shippingCharge: e.target.value })} />
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="ship-notes">Notas</label>
              <textarea id="ship-notes" className="input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            {!shipped ? (
              <div className="pkg-ship-delivered">
                <label className="pkg-check">
                  <input type="checkbox" checked={form.delivered} onChange={(e) => setForm({ ...form, delivered: e.target.checked })} /> Envío ya entregado
                </label>
                {form.delivered ? (
                  <input type="date" className="input" aria-label="Fecha de entrega" value={form.deliveryDate} onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })} />
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Guardando en Zoho…' : shipped ? 'Guardar cambios' : 'Enviar paquete'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'deliver'} onOpenChange={(v) => !v && !busy && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Marcar como entregado</DialogTitle>
            <DialogDescription>La orden de envío {pkg.shipmentNumber ?? ''} pasará a “Entregado” en Zoho.</DialogDescription>
          </DialogHeader>
          <div className="form-field">
            <label htmlFor="deliver-date">Fecha de entrega</label>
            <input id="deliver-date" type="date" className="input" value={deliveredDate} onChange={(e) => setDeliveredDate(e.target.value)} />
          </div>
          <DialogFooter>
            <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>Cancelar</button>
            <button type="button" className="btn btn-primary" onClick={() => void submitDeliver()} disabled={busy}>{busy ? 'Guardando…' : 'Marcar entregado'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'cancel'} onOpenChange={(v) => !v && !busy && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancelar envío</DialogTitle>
            <DialogDescription>
              Se elimina la orden de envío {pkg.shipmentNumber ?? ''} en Zoho y el paquete vuelve a “No enviado”. El transportista se quita. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>Volver</button>
            <button type="button" className="btn btn-danger" onClick={() => void submitCancel()} disabled={busy}>{busy ? 'Eliminando…' : 'Eliminar orden de envío'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'edit'} onOpenChange={(v) => !v && !busy && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar {pkg.packageNumber ?? 'paquete'}</DialogTitle>
            <DialogDescription>Fecha y notas del paquete. Los artículos se editan en Zoho.</DialogDescription>
          </DialogHeader>
          <form
            className="pkg-ship-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitEdit();
            }}
          >
            <div className="form-field">
              <label htmlFor="edit-date">Fecha del paquete</label>
              <input id="edit-date" type="date" className="input" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
            </div>
            <div className="form-field">
              <label htmlFor="edit-notes">Notas</label>
              <textarea id="edit-notes" className="input" rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            </div>
            <DialogFooter>
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Guardando en Zoho…' : 'Guardar'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
