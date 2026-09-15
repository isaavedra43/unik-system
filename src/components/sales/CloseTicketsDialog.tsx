'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/shadcn/alert-dialog';

interface CloseTicketResult {
  orderId: string;
  salesOrderNumber: string | null;
  outcome: 'closed' | 'partial' | 'skipped' | 'failed';
  finalStatus: string | null;
  steps: string[];
  error?: string;
}

interface JobState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  result: { total: number; processed: number; results: CloseTicketResult[] } | null;
  error: string | null;
}

const OUTCOME_LABEL: Record<CloseTicketResult['outcome'], string> = {
  closed: 'Cerrada',
  partial: 'Incompleta',
  skipped: 'Omitida',
  failed: 'Falló',
};

const MAX_ORDERS = 200;
const POLL_MS = 2000;

export function CloseTicketsDialog({
  orders,
  onFinished,
}: {
  orders: { id: string; salesOrderNumber: string | null }[];
  onFinished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const total = orders.length;
  const finishedRef = useRef(false);

  const done = job?.status === 'completed' || job?.status === 'failed' || job?.status === 'cancelled';

  useEffect(() => {
    if (!jobId || done) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/app/sales/orders/close-tickets/${jobId}`).catch(() => null);
      if (!res?.ok) return;
      setJob((await res.json()) as JobState);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [jobId, done]);

  useEffect(() => {
    if (done && !finishedRef.current) {
      finishedRef.current = true;
      onFinished();
    }
  }, [done, onFinished]);

  const start = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/app/sales/orders/close-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: orders.map((o) => o.id) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'No se pudo iniciar el cierre');
      finishedRef.current = false;
      setJob({ status: 'pending', progress: 0, result: null, error: null });
      setJobId(json.jobId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo iniciar el cierre');
    } finally {
      setSubmitting(false);
    }
  }, [orders]);

  const handleOpenChange = (next: boolean) => {
    // Keep the dialog open while the job runs so progress stays visible.
    if (!next && jobId && !done) return;
    setOpen(next);
    if (!next) {
      setJobId(null);
      setJob(null);
    }
  };

  const results = job?.result?.results ?? [];
  const count = (o: CloseTicketResult['outcome']) => results.filter((r) => r.outcome === o).length;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <button className="btn btn-secondary btn-sm" disabled={total === 0}>
          <CheckCircle2 size={14} /> Cerrar tickets
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {jobId ? 'Cierre de tickets' : `¿Cerrar ${total} ${total === 1 ? 'ticket' : 'tickets'} en Zoho?`}
          </AlertDialogTitle>
          {!jobId ? (
            <AlertDialogDescription asChild>
              <div>
                <p>Para cada orden seleccionada, en Zoho se hará lo que falte de esto:</p>
                <ol style={{ margin: '0.5rem 0 0.5rem 1.25rem', listStyle: 'decimal' }}>
                  <li>Crear la factura y marcarla como enviada.</li>
                  <li>Empacar lo que no esté empacado.</li>
                  <li>Crear la orden de envío y marcarla como entregada.</li>
                  <li>Agregar el comentario «cierre de ticket por claude».</li>
                </ol>
                <p>
                  Las órdenes anuladas, en borrador o ya cerradas se omiten. Las facturas y envíos
                  creados no se deshacen desde UNIK.
                </p>
                {total > MAX_ORDERS ? (
                  <p style={{ color: 'var(--unik-danger)' }}>
                    Máximo {MAX_ORDERS} órdenes por cierre; seleccionaste {total}.
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription asChild>
              <div>
                {!done ? (
                  <p>
                    Procesando {job?.result?.processed ?? 0} de {total}… ({job?.progress ?? 0}%). Puedes
                    esperar aquí; el proceso sigue aunque cierres la página.
                  </p>
                ) : (
                  <p>
                    Terminado: {count('closed')} cerradas, {count('partial')} incompletas,{' '}
                    {count('skipped')} omitidas, {count('failed')} con error.
                    {job?.status === 'failed' && job.error ? ` Error del proceso: ${job.error}` : ''}
                  </p>
                )}
                {results.length > 0 ? (
                  <ul style={{ maxHeight: 260, overflowY: 'auto', marginTop: '0.75rem', fontSize: '0.85rem' }}>
                    {results.map((r) => (
                      <li key={r.orderId} style={{ padding: '0.35rem 0', borderTop: '1px solid var(--unik-border)' }}>
                        <strong>{r.salesOrderNumber ?? r.orderId}</strong> — {OUTCOME_LABEL[r.outcome]}
                        {r.error ? `: ${r.error}` : ''}
                        {r.steps.length > 0 ? (
                          <div style={{ color: 'var(--unik-text-muted)' }}>{r.steps.join(' · ')}</div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!jobId ? (
            <>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                disabled={submitting || total === 0 || total > MAX_ORDERS}
                onClick={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                {submitting ? 'Iniciando…' : 'Cerrar tickets'}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogCancel disabled={!done}>{done ? 'Cerrar' : 'Procesando…'}</AlertDialogCancel>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
