'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, Checkbox } from '@/components/ui/primitives';
import {
  PROJECTIONS_REBUILD_ENDPOINT,
  projectionsRebuildFeedback,
  type ProjectionsRebuildResponse,
} from './overview-model';

/**
 * Recálculo total de las proyecciones de inteligencia de procesos (plan 7.9:
 * «rebuild completo con `{full:true}` desde admin»).
 *
 * La ruta `POST /app/admin/control-tower/api/projections/rebuild` existía y
 * ningún componente la llamaba: quien administra veía en el resumen que una
 * proyección estaba atrasada y no tenía forma de reconstruirla.
 *
 * Por omisión ENCOLA el job (`ct.projections_refresh`, deduplicado: diez clics
 * son una corrida) y responde de inmediato. «Esperar el resultado» corre en
 * línea y devuelve qué escribió cada proyección, que es lo único que sirve
 * cuando algo no cuadra — y por eso se avisa de que puede tardar minutos.
 */

export interface ProjectionsRebuildButtonProps {
  /** Se llama tras un recálculo en línea, para volver a pedir el resumen. */
  onDone?: () => void;
  /** Etiqueta del botón (por omisión "Reconstruir"). */
  label?: string;
}

export function ProjectionsRebuildButton({
  onDone,
  label = 'Reconstruir',
}: ProjectionsRebuildButtonProps) {
  const [open, setOpen] = useState(false);
  const [wait, setWait] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setDetail(null);
    try {
      const response = await fetch(PROJECTIONS_REBUILD_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ full: true, wait }),
      });
      const payload = (await response
        .json()
        .catch(() => null)) as ProjectionsRebuildResponse | null;
      const feedback = projectionsRebuildFeedback(payload, { ok: response.ok });
      if (feedback.tone === 'error') {
        setDetail(feedback.detail);
        toast.error(feedback.message);
        return;
      }
      toast.success(feedback.message);
      setOpen(false);
      setDetail(null);
      if (wait) onDone?.();
    } catch {
      toast.error('No pudimos pedir el recálculo; revisa tu conexión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Reconstruir las proyecciones de inteligencia de procesos"
      >
        <RefreshCw size={14} aria-hidden="true" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={(next) => (busy ? null : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconstruir las proyecciones</DialogTitle>
            <DialogDescription>
              Recalcula desde cero las variantes de proceso, las métricas por paso, los traspasos
              entre áreas y las causas de bloqueo. No borra nada del expediente: sólo vuelve a leer
              los eventos. Es pesado, así que normalmente se encola.
            </DialogDescription>
          </DialogHeader>

          <Checkbox
            label="Esperar el resultado (puede tardar minutos)"
            checked={wait}
            onChange={(event) => setWait(event.target.checked)}
            disabled={busy}
          />

          {detail ? <Alert variant="warning">{detail}</Alert> : null}

          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? 'Reconstruyendo…' : 'Reconstruir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
