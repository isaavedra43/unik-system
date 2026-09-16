'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Alert, Button, FormField, Select, Textarea } from '@/components/ui/primitives';
import { recordSupplierEvaluationAction } from './compras-actions';

interface SupplierView {
  supplier: {
    id: string;
    name: string;
    rating: { overall: string | null };
    evaluationsCount: number;
  };
}

export interface SupplierEvaluationPanelProps {
  areaKey: string;
  supplierId: string;
  canAct: boolean;
}

/** Human evaluation of a supplier, saved through the canonical rating command. */
export function SupplierEvaluationPanel({
  areaKey,
  supplierId,
  canAct,
}: SupplierEvaluationPanelProps) {
  const [supplier, setSupplier] = useState<SupplierView['supplier'] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [scores, setScores] = useState({
    onTime: '5',
    quality: '5',
    price: '5',
    communication: '5',
  });
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/compras/suppliers/${encodeURIComponent(supplierId)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) throw new Error('supplier_fetch_failed');
      const body = (await response.json()) as SupplierView;
      setSupplier(body.supplier);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, supplierId]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit() {
    if (!supplier) return;
    const values = Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, Number(value)])
    ) as Record<keyof typeof scores, number>;
    if (Object.values(values).some((value) => !Number.isInteger(value) || value < 1 || value > 5)) {
      setError('Cada calificación debe estar entre 1 y 5');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await recordSupplierEvaluationAction({
        supplierId: supplier.id,
        ...values,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Evaluación guardada; la calificación del proveedor se actualizó');
      setComment('');
      await load();
    });
  }

  if (state === 'loading')
    return <LoadingState variant="list" rows={2} label="Cargando proveedor…" />;
  if (state === 'failed' || !supplier)
    return (
      <ErrorState
        title="No pudimos abrir el proveedor"
        message="Recarga la página e inténtalo de nuevo."
      />
    );

  return (
    <section className="area-drawer-section" aria-labelledby="supplier-evaluation">
      <h3 id="supplier-evaluation" className="area-drawer-section-title">
        Evaluar proveedor
      </h3>
      <p className="area-row-sub">
        {supplier.name} · calificación actual {supplier.rating.overall ?? 'sin calificar'} ·{' '}
        {supplier.evaluationsCount} evaluación(es)
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {!canAct ? (
        <p className="area-row-sub">
          Puedes consultar las evaluaciones; quien recibe o gestiona Compras puede agregar una.
        </p>
      ) : null}
      {canAct ? (
        <>
          <div className="compras-response-form">
            {(
              [
                ['onTime', 'Entrega a tiempo'],
                ['quality', 'Calidad'],
                ['price', 'Precio'],
                ['communication', 'Comunicación'],
              ] as const
            ).map(([key, label]) => (
              <FormField key={key} label={label} htmlFor={`${key}-${supplier.id}`}>
                <Select
                  id={`${key}-${supplier.id}`}
                  value={scores[key]}
                  disabled={pending}
                  onChange={(event) =>
                    setScores((current) => ({ ...current, [key]: event.target.value }))
                  }
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value} / 5
                    </option>
                  ))}
                </Select>
              </FormField>
            ))}
            <FormField label="Comentario (opcional)" htmlFor={`supplier-comment-${supplier.id}`}>
              <Textarea
                id={`supplier-comment-${supplier.id}`}
                rows={2}
                maxLength={1000}
                value={comment}
                disabled={pending}
                onChange={(event) => setComment(event.target.value)}
              />
            </FormField>
            <div className="area-drawer-actions">
              <Button size="sm" disabled={pending} onClick={submit}>
                {pending ? 'Guardando…' : 'Guardar evaluación'}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
