'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/composite';
import { Alert, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { SourcingCandidateView } from './sourcing-types';

/**
 * The two decisions the Sourcing Lab writes to the operation (plan 7.6):
 * asking candidates for a quotation (an RFQ sent through the inbox) and
 * promoting a candidate to a supplier of UNIK.
 *
 * Both dialogs only collect what the command needs; the rules live in
 * `purchases-commands.ts` and are validated again on the server, so a stale
 * form can never write something the engine would refuse.
 */

export interface RequestQuoteValues {
  title: string;
  description: string;
  qty: number;
  unit: string;
  dueDays: number;
}

export interface RequestQuoteDialogProps {
  candidates: SourcingCandidateView[];
  defaultDueDays: number;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: RequestQuoteValues) => void;
}

export function RequestQuoteDialog({
  candidates,
  defaultDueDays,
  busy,
  error,
  onClose,
  onSubmit,
}: RequestQuoteDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('pieza');
  const [dueDays, setDueDays] = useState(String(defaultDueDays));
  const [localError, setLocalError] = useState<string | null>(null);

  const names = candidates.map((candidate) => candidate.name).join(', ');

  function submit() {
    const quantity = Number(qty);
    if (title.trim().length < 3) {
      setLocalError('Escribe de qué es la cotización');
      return;
    }
    if (description.trim().length < 3) {
      setLocalError('Describe el material que vas a pedir');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setLocalError('La cantidad debe ser mayor que cero');
      return;
    }
    if (!unit.trim()) {
      setLocalError('Indica la unidad (pieza, m2, tonelada…)');
      return;
    }
    setLocalError(null);
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      qty: quantity,
      unit: unit.trim(),
      dueDays: Number(dueDays) || defaultDueDays,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Solicitar cotización"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" onClick={submit} isLoading={busy}>
            Enviar solicitud
          </Button>
        </>
      }
    >
      <p className="compras-lab-hint">
        Se creará una cotización y se enviará por la bandeja a: {names}.
      </p>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {localError ? <Alert variant="warning">{localError}</Alert> : null}

      <FormField label="Título de la cotización" htmlFor="rfq-title">
        <Input
          id="rfq-title"
          value={title}
          maxLength={200}
          placeholder="Lámina galvanizada para la obra del norte"
          onChange={(event) => setTitle(event.target.value)}
        />
      </FormField>

      <FormField label="Material" htmlFor="rfq-description">
        <Input
          id="rfq-description"
          value={description}
          maxLength={300}
          placeholder="Lámina galvanizada calibre 22"
          onChange={(event) => setDescription(event.target.value)}
        />
      </FormField>

      <FormField label="Cantidad" htmlFor="rfq-qty">
        <Input
          id="rfq-qty"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={qty}
          onChange={(event) => setQty(event.target.value)}
        />
      </FormField>

      <FormField label="Unidad" htmlFor="rfq-unit">
        <Input
          id="rfq-unit"
          value={unit}
          maxLength={40}
          onChange={(event) => setUnit(event.target.value)}
        />
      </FormField>

      <FormField
        label="Días para responder"
        htmlFor="rfq-due"
        help="Después de ese plazo la cotización se marca como vencida."
      >
        <Input
          id="rfq-due"
          type="number"
          min="1"
          max="60"
          value={dueDays}
          onChange={(event) => setDueDays(event.target.value)}
        />
      </FormField>
    </Modal>
  );
}

export interface PromoteSupplierValues {
  name: string;
  paymentMode: 'prepaid' | 'credit' | 'cod';
  paymentTermsDays: number | null;
  leadTimeDaysDefault: number | null;
}

export interface PromoteSupplierDialogProps {
  candidate: SourcingCandidateView;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: PromoteSupplierValues) => void;
}

export function PromoteSupplierDialog({
  candidate,
  busy,
  error,
  onClose,
  onSubmit,
}: PromoteSupplierDialogProps) {
  const [name, setName] = useState(candidate.name);
  const [paymentMode, setPaymentMode] = useState<'prepaid' | 'credit' | 'cod'>('prepaid');
  const [paymentTermsDays, setPaymentTermsDays] = useState('');
  const [leadTime, setLeadTime] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit() {
    if (name.trim().length < 2) {
      setLocalError('El nombre del proveedor es muy corto');
      return;
    }
    setLocalError(null);
    onSubmit({
      name: name.trim(),
      paymentMode,
      paymentTermsDays: paymentTermsDays.trim() ? Number(paymentTermsDays) : null,
      leadTimeDaysDefault: leadTime.trim() ? Number(leadTime) : null,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Convertir en proveedor"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" onClick={submit} isLoading={busy}>
            Dar de alta
          </Button>
        </>
      }
    >
      <p className="compras-lab-hint">
        Se creará el proveedor con los datos de contacto del candidato. Si ya existe uno con el
        mismo teléfono, dominio o RFC, se vincula al que ya está.
      </p>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {localError ? <Alert variant="warning">{localError}</Alert> : null}

      <FormField label="Nombre del proveedor" htmlFor="promote-name">
        <Input
          id="promote-name"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>

      <FormField label="Forma de pago" htmlFor="promote-payment">
        <Select
          id="promote-payment"
          value={paymentMode}
          onChange={(event) => setPaymentMode(event.target.value as 'prepaid' | 'credit' | 'cod')}
        >
          <option value="prepaid">Pago anticipado</option>
          <option value="credit">Crédito</option>
          <option value="cod">Contra entrega</option>
        </Select>
      </FormField>

      {paymentMode === 'credit' ? (
        <FormField label="Días de crédito" htmlFor="promote-terms">
          <Input
            id="promote-terms"
            type="number"
            min="0"
            max="365"
            value={paymentTermsDays}
            onChange={(event) => setPaymentTermsDays(event.target.value)}
          />
        </FormField>
      ) : null}

      <FormField
        label="Plazo de entrega habitual (días)"
        htmlFor="promote-lead"
        help="Se usa para estimar cuándo llegaría el material."
      >
        <Input
          id="promote-lead"
          type="number"
          min="0"
          max="365"
          value={leadTime}
          onChange={(event) => setLeadTime(event.target.value)}
        />
      </FormField>
    </Modal>
  );
}
