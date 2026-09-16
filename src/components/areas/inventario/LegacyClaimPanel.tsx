'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  confirmLegacyClaimAction,
  releaseLegacyClaimAction,
} from '@/app/app/areas/inventario/actions';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
} from '@/components/ui/primitives';
import type { LegacyClaimDetail } from '@/modules/areas/inventario/inventory-area-queries';
import {
  DECISION_NOTE_MAX,
  buildClaimConfirmation,
  claimExpiryLabel,
  demandOptionKey,
  formatQty,
} from './inventario-model';

/**
 * Reclamo legado (plan §3.3 "corte"): lo prometido ANTES de que UNIK controlara
 * la bodega. Mientras está reclamado resta del disponible; aquí se CONFIRMA
 * contra la necesidad de un expediente (y se vuelve reserva) o se LIBERA.
 *
 * Confirmar necesita elegir un expediente y una de sus necesidades, que es
 * justo lo que el diálogo genérico de una fila (una nota, un motivo) no puede
 * pedir. Sin este panel el mecanismo de corte no tenía cómo cerrarse: sólo el
 * barrido por TTL del supervisor terminaba los reclamos.
 */

export interface LegacyClaimPanelProps {
  areaKey: string;
  claimId: string;
}

type ClaimPayload = LegacyClaimDetail & { can?: { manage?: boolean } };

export function LegacyClaimPanel({ areaKey, claimId }: LegacyClaimPanelProps) {
  const [detail, setDetail] = useState<ClaimPayload | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [demandKey, setDemandKey] = useState('');
  const [allowProvisional, setAllowProvisional] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/inventario/claims/${encodeURIComponent(claimId)}`,
        { headers: { accept: 'application/json' } }
      );
      const body = (await response.json().catch(() => ({}))) as Partial<ClaimPayload> & {
        error?: string;
      };
      if (!response.ok || !body.claim) throw new Error(body.error ?? 'claim_fetch_failed');
      setDetail(body as ClaimPayload);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'loading') {
    return <LoadingState variant="list" rows={2} label="Cargando el compromiso…" />;
  }
  if (state === 'failed' || !detail) {
    return (
      <ErrorState
        title="No pudimos cargar el compromiso"
        message="Vuelve a intentarlo; el reclamo sigue donde estaba."
        onRetry={() => {
          setState('loading');
          void load();
        }}
      />
    );
  }

  const { claim, demands } = detail;
  const canManage = detail.can?.manage === true;
  const open = claim.status === 'claimed';

  function finish(result: { ok: boolean; message?: string; error?: string }) {
    if (result.ok) {
      toast.success(result.message ?? 'Listo');
      setError(null);
      void load();
    } else {
      setError(result.error ?? 'No se pudo completar la acción');
      toast.error(result.error ?? 'No se pudo completar la acción');
    }
  }

  function confirm() {
    const input = buildClaimConfirmation({ claimId: claim.id, demandKey, allowProvisional });
    if (!input.ok) {
      setError(input.error);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await confirmLegacyClaimAction(input.value);
      finish(
        result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error }
      );
    });
  }

  function release() {
    const text = reason.trim();
    if (!text) {
      setError('Di por qué se libera el compromiso');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await releaseLegacyClaimAction({ claimId: claim.id, reason: text });
      finish(
        result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error }
      );
    });
  }

  return (
    <section className="area-drawer-section" aria-labelledby="inv-claim-panel">
      <h3 id="inv-claim-panel" className="area-drawer-section-title">
        Compromiso previo al corte
      </h3>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="inv-card">
        <p className="inv-card-title">
          <span>
            {claim.productName ?? claim.sku ?? claim.zohoItemId} ·{' '}
            {formatQty(claim.quantity, claim.unit)}
          </span>
          <Badge variant={open ? 'warning' : 'weak'}>
            {open ? claimExpiryLabel(claim.expiresAt) : 'Resuelto'}
          </Badge>
        </p>
        <p className="inv-card-hint">
          {[claim.warehouseName, claim.reference].filter(Boolean).join(' · ') ||
            'Sin referencia registrada'}
        </p>
      </div>

      {!open ? (
        <Alert variant="info">
          Este compromiso ya está resuelto, así que no resta del disponible. Si el cliente lo sigue
          esperando, registra uno nuevo desde Existencias.
        </Alert>
      ) : !canManage ? (
        <Alert variant="info">
          Ves el compromiso, pero confirmarlo o liberarlo necesita el permiso de reservar
          inventario.
        </Alert>
      ) : (
        <>
          <div className="inv-card">
            <p className="inv-card-title">
              <span>Confirmar contra un expediente</span>
            </p>
            <p className="inv-card-hint">
              Al confirmarlo deja de ser reclamo y se vuelve una reserva de esa necesidad: el
              disponible no se mueve, pero el compromiso ya tiene dueño.
            </p>
            {demands.length === 0 ? (
              <p className="inv-card-hint">
                Ningún expediente abierto pide este artículo todavía. Cuando la venta entre a UNIK
                aparecerá aquí.
              </p>
            ) : (
              <div className="inv-form-grid">
                <FormField label="Necesidad del expediente" htmlFor="inv-claim-demand">
                  <Select
                    id="inv-claim-demand"
                    value={demandKey}
                    onChange={(event) => setDemandKey(event.target.value)}
                  >
                    <option value="">Elige la necesidad…</option>
                    {demands.map((demand) => (
                      <option
                        key={demand.demandId}
                        value={demandOptionKey(demand.caseId, demand.demandId)}
                      >
                        {demand.caseNumber} · {demand.customerName ?? 'Sin cliente'} ·{' '}
                        {formatQty(demand.pendingQuantity, demand.baseUnit)} por cubrir
                      </option>
                    ))}
                  </Select>
                </FormField>
                <Checkbox
                  label="Permitir aunque el artículo sea provisional"
                  checked={allowProvisional}
                  onChange={(event) => setAllowProvisional(event.target.checked)}
                />
                <div className="inv-capture-actions">
                  <Button size="sm" onClick={confirm} isLoading={pending} disabled={pending}>
                    Confirmar compromiso
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="inv-card">
            <p className="inv-card-title">
              <span>Liberar el compromiso</span>
            </p>
            <p className="inv-card-hint">
              La cantidad vuelve al disponible de inmediato. Úsalo cuando el cliente ya no lo espera
              o cuando el compromiso se registró por error.
            </p>
            <div className="inv-form-grid">
              <FormField label="Motivo" htmlFor="inv-claim-reason">
                <Input
                  id="inv-claim-reason"
                  value={reason}
                  maxLength={DECISION_NOTE_MAX}
                  autoComplete="off"
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Por qué se libera"
                />
              </FormField>
              <div className="inv-capture-actions">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={release}
                  isLoading={pending}
                  disabled={pending}
                >
                  Liberar
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
