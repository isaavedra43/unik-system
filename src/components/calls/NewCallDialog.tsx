'use client';

import React, { useEffect, useState } from 'react';
import { Phone, Users } from 'lucide-react';
import { Modal } from '@/components/ui/composite';
import { Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import type { IssuedToken } from '@/modules/voice/livekit-service';

interface DirectoryUser {
  id: string;
  name: string;
  username: string;
}
interface DirectoryAccount {
  id: string;
  label: string;
  identifier: string;
}

export interface NewCallDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (call: VoiceCallDTO, token: IssuedToken) => void;
}

export function NewCallDialog({ open, onClose, onCreated }: NewCallDialogProps) {
  const [mode, setMode] = useState<'internal' | 'outbound'>('internal');
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [accounts, setAccounts] = useState<DirectoryAccount[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [toNumber, setToNumber] = useState('');
  const [accountId, setAccountId] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/app/calls/api/directory')
      .then(async (res) => {
        if (!res.ok) throw new Error('No se pudo cargar el directorio');
        const data = (await res.json()) as { users: DirectoryUser[]; accounts: DirectoryAccount[] };
        if (!cancelled) {
          setUsers(data.users);
          setAccounts(data.accounts);
          if (data.accounts.length > 0) setAccountId(data.accounts[0].id);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body =
        mode === 'internal'
          ? { type: 'internal', calleeUserIds: selected }
          : { type: 'outbound', toNumber: toNumber.trim(), accountId: accountId || undefined };
      const res = await fetch('/app/calls/api/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        call?: VoiceCallDTO;
        token?: IssuedToken;
      };
      if (!res.ok || !data.call || !data.token) {
        setError(data.error ?? 'No se pudo iniciar la llamada');
        return;
      }
      onCreated(data.call, data.token);
      setSelected([]);
      setToNumber('');
      onClose();
    } catch {
      setError('Error de red');
    } finally {
      setSubmitting(false);
    }
  }

  const visibleUsers = users.filter(
    (u) =>
      !filter ||
      u.name.toLowerCase().includes(filter.toLowerCase()) ||
      u.username.includes(filter.toLowerCase())
  );
  const canSubmit =
    !submitting &&
    (mode === 'internal' ? selected.length > 0 : /^\+[1-9]\d{6,14}$/.test(toNumber.trim()));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nueva llamada"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            isLoading={submitting}
            icon={<Phone size={16} />}
          >
            {mode === 'internal' ? 'Llamar' : 'Marcar'}
          </Button>
        </>
      }
    >
      <div
        style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}
        role="tablist"
        aria-label="Tipo de llamada"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'internal'}
          className={`btn btn-sm ${mode === 'internal' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('internal')}
        >
          <Users size={14} aria-hidden="true" /> Interna
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'outbound'}
          className={`btn btn-sm ${mode === 'outbound' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('outbound')}
        >
          <Phone size={14} aria-hidden="true" /> Externa (teléfono)
        </button>
      </div>

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? <p className="text-muted">Cargando directorio…</p> : null}

      {mode === 'internal' ? (
        <>
          <FormField label="Buscar usuario" htmlFor="call-user-filter">
            <Input
              id="call-user-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Nombre o usuario"
            />
          </FormField>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {visibleUsers.length === 0 && !loading ? (
              <p className="text-muted" style={{ padding: '0.75rem' }}>
                Sin usuarios disponibles.
              </p>
            ) : (
              visibleUsers.map((u) => (
                <label
                  key={u.id}
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'center',
                    padding: '0.4rem 0.75rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(u.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id)
                      )
                    }
                  />
                  <span>{u.name}</span>
                  <span className="text-muted">@{u.username}</span>
                </label>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <FormField label="Número (E.164)" htmlFor="call-number" help="Ejemplo: +5215512345678">
            <Input
              id="call-number"
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              placeholder="+52…"
              inputMode="tel"
              autoComplete="off"
            />
          </FormField>
          <FormField
            label="Cuenta saliente"
            htmlFor="call-account"
            help={
              accounts.length === 0
                ? 'No hay cuentas Twilio de tus equipos; se usará el trunk por defecto.'
                : undefined
            }
          >
            <Select
              id="call-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={accounts.length === 0}
            >
              {accounts.length === 0 ? <option value="">Trunk por defecto</option> : null}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {a.identifier}
                </option>
              ))}
            </Select>
          </FormField>
        </>
      )}
    </Modal>
  );
}
