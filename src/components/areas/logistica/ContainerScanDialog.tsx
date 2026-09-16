'use client';

import { useState } from 'react';
import { Barcode, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { ScanInput } from '@/components/areas/ScanInput';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, Select } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { DispatchDelivery } from '@/modules/areas/logistica/logistics-view-model';
import { scanDeliveryContainerInput } from '@/modules/areas/logistica/logistics-view-model';
import type { ScanLookup } from '@/modules/operations/scan-resolver';

/**
 * Scanner of physical containers at the dock. It deliberately submits only
 * after the shared scanner recognizes one exact stock item; the server then
 * verifies that item against the allocation before persisting the read.
 */
export function ContainerScanDialog({
  delivery,
  online,
  onClose,
  onSubmit,
}: {
  delivery: DispatchDelivery;
  online: boolean;
  onClose: () => void;
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    message: string
  ) => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<'loading' | 'dispatch'>('loading');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  async function record(lookup: ScanLookup) {
    if (busy) return;
    if (!online) {
      toast.error(
        'Necesitas conexión para validar el contenedor contra la entrega antes de cargarlo.'
      );
      return;
    }
    if (lookup.kind !== 'stock_item' || lookup.items.length !== 1) {
      toast.error('Escanea la etiqueta de un contenedor, rollo o placa individual.');
      return;
    }
    setBusy(true);
    try {
      const ok = await onSubmit(
        scanDeliveryContainerInput(delivery, lookup.code, phase),
        phase === 'loading' ? 'Contenedor cargado' : 'Contenedor despachado'
      );
      if (ok) {
        setLast(lookup.items[0]?.subtitle || lookup.items[0]?.title || lookup.code);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Escanear contenedor</DialogTitle>
          <DialogDescription>
            {delivery.customerName ?? delivery.caseNumber ?? 'Entrega'} · cada lectura queda ligada
            a esta entrega y se rechaza si el material no pertenece a sus partidas.
          </DialogDescription>
        </DialogHeader>

        {!online ? (
          <Alert variant="warning">
            El escaneo requiere conexión: primero validamos que el contenedor corresponda a esta
            entrega antes de registrarlo.
          </Alert>
        ) : null}

        <label className="form-field">
          <span className="form-label">Momento del escaneo</span>
          <Select
            value={phase}
            disabled={busy || !online}
            onChange={(event) => setPhase(event.target.value as 'loading' | 'dispatch')}
          >
            <option value="loading">Al cargar la unidad</option>
            <option value="dispatch">Al despachar el viaje</option>
          </Select>
        </label>

        <ScanInput
          autoFocus
          onResolved={(lookup) => void record(lookup)}
          footer={(lookup) =>
            lookup.kind === 'stock_item' ? (
              <p className="area-scan-hint">
                Se validará y registrará al seleccionar este contenedor.
              </p>
            ) : null
          }
        />

        {last ? (
          <Alert variant="success">
            <PackageCheck className="h-4 w-4" aria-hidden="true" /> Lectura guardada: {last}
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cerrar
          </Button>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Barcode className="h-4 w-4" aria-hidden="true" /> QR, pistola o código manual
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
