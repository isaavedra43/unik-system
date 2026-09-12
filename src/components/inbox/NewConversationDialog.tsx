'use client';

import React, { useEffect, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Modal } from '@/components/ui/composite';
import { Button, FormField, Input, Select, Textarea } from '@/components/ui/primitives';
import { apiJson, type CommAccountDTO, type CommConversationDTO } from './inbox-types';

/**
 * Starts a conversation from the inbox: pick the account (number/bot), the
 * destination and the first message. WhatsApp only accepts free text when
 * the contact wrote in the last 24 hours; otherwise an approved template
 * (Content SID) is required.
 */
export function NewConversationDialog({
  open,
  accounts,
  onClose,
  onCreated,
}: {
  open: boolean;
  accounts: CommAccountDTO[];
  onClose: () => void;
  onCreated: (conversation: CommConversationDTO) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [to, setTo] = useState('');
  const [contactName, setContactName] = useState('');
  const [body, setBody] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [open, accounts, accountId]);

  const account = accounts.find((a) => a.id === accountId);
  const isTelegram = account?.provider === 'telegram';
  const isWhatsApp = account?.provider === 'twilio_whatsapp';

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiJson<{ conversation: CommConversationDTO }>(
        '/app/inbox/api/conversations/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId,
            to: to.trim(),
            contactName: contactName.trim() || undefined,
            body: body.trim() || undefined,
            templateKey: templateKey.trim() || undefined,
          }),
        }
      );
      onCreated(data.conversation);
      setTo('');
      setContactName('');
      setBody('');
      setTemplateKey('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la conversación');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nueva conversación"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={submitting || !accountId || to.trim().length < 3}>
            <MessageSquarePlus size={16} /> {submitting ? 'Enviando…' : 'Iniciar'}
          </Button>
        </>
      }
    >
      {error && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '0.75rem' }}>
          {error}
        </div>
      )}
      <FormField label="Canal" htmlFor="nc-account">
        <Select id="nc-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} · {a.identifier}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label={isTelegram ? 'Chat ID de Telegram' : 'Número del contacto'}
        htmlFor="nc-to"
        help={
          isTelegram
            ? 'El contacto debe haber escrito antes al bot.'
            : 'Formato +52 y 10 dígitos, ej. +5214791234567'
        }
      >
        <Input
          id="nc-to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={isTelegram ? '123456789' : '+5214791234567'}
          autoFocus
        />
      </FormField>
      <FormField label="Nombre (opcional)" htmlFor="nc-name">
        <Input id="nc-name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
      </FormField>
      <FormField
        label="Primer mensaje"
        htmlFor="nc-body"
        help={
          isWhatsApp
            ? 'Si el contacto no te ha escrito en las últimas 24 h, WhatsApp exige una plantilla aprobada (abajo).'
            : undefined
        }
      >
        <Textarea id="nc-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      {isWhatsApp && (
        <FormField
          label="Plantilla aprobada (Content SID, opcional)"
          htmlFor="nc-template"
          help="Twilio → Content Template Builder → copia el SID que empieza con HX."
        >
          <Input
            id="nc-template"
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            placeholder="HX…"
          />
        </FormField>
      )}
    </Modal>
  );
}
