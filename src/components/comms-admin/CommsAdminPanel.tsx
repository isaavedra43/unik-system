'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Drawer, Modal } from '@/components/ui/composite';
import type { CommAccountDTO, DuplicateCandidateDTO } from '@/modules/comms/comms-service';
import type { ResponsibleDTO } from '@/modules/comms/responsibles-service';
import { apiJson, PROVIDER_LABELS } from '@/components/inbox/inbox-types';

type TabId = 'accounts' | 'responsibles' | 'duplicates';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'accounts', label: 'Cuentas y canales' },
  { id: 'responsibles', label: 'Responsables' },
  { id: 'duplicates', label: 'Duplicados pendientes' },
];

interface RoleOption {
  key: string;
  name: string;
}
interface UserOption {
  id: string;
  name: string;
  username: string;
}

/**
 * Channel administration. Credentials are sent once over HTTPS and stored as
 * an encrypted team connection; the browser never receives them back. The
 * Telegram webhook secret is displayed a single time after creation/rotation.
 */
export function CommsAdminPanel() {
  const [tab, setTab] = useState<TabId>('accounts');
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);

  useEffect(() => {
    apiJson<{ roles: RoleOption[] }>('/app/admin/comms/api/roles')
      .then((d) => setRoles(d.roles))
      .catch(() => setRoles([]));
    apiJson<{ users: UserOption[] }>('/app/admin/comms/api/users')
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, []);

  return (
    <div className="assistant-admin-panel">
      <div className="assistant-admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`assistant-admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="assistant-admin-tab-content">
        {tab === 'accounts' && <AccountsTab roles={roles} />}
        {tab === 'responsibles' && <ResponsiblesTab users={users} />}
        {tab === 'duplicates' && <DuplicatesTab />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

function AccountsTab({ roles }: { roles: RoleOption[] }) {
  const [accounts, setAccounts] = useState<CommAccountDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CommAccountDTO | null | 'new'>(null);
  const [secret, setSecret] = useState<{
    label: string;
    secret: string;
    webhookUrl: string;
  } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson<{ accounts: CommAccountDTO[] }>('/app/admin/comms/api/accounts');
      setAccounts(data.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las cuentas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async (account: CommAccountDTO) => {
    setBusyId(account.id);
    try {
      const result = await apiJson<{ ok: boolean; detail: string }>(
        `/app/admin/comms/api/accounts/${account.id}/test`,
        { method: 'POST' }
      );
      setTestResult((prev) => ({ ...prev, [account.id]: result }));
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [account.id]: { ok: false, detail: err instanceof Error ? err.message : 'Error' },
      }));
    } finally {
      setBusyId(null);
    }
  };

  const toggleStatus = async (account: CommAccountDTO) => {
    setBusyId(account.id);
    try {
      await apiJson(`/app/admin/comms/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: account.status === 'active' ? 'paused' : 'active' }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
    } finally {
      setBusyId(null);
    }
  };

  const rotateSecret = async (account: CommAccountDTO) => {
    setBusyId(account.id);
    try {
      const data = await apiJson<{ account: CommAccountDTO; webhookSecret: string | null }>(
        `/app/admin/comms/api/accounts/${account.id}`,
        { method: 'PATCH', body: JSON.stringify({ rotateWebhookSecret: true }) }
      );
      if (data.webhookSecret)
        setSecret({
          label: account.label,
          secret: data.webhookSecret,
          webhookUrl: data.account.webhookUrl,
        });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo rotar el secreto');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (account: CommAccountDTO) => {
    if (!window.confirm(`¿Eliminar la cuenta "${account.label}"? Solo es posible sin historial.`))
      return;
    setBusyId(account.id);
    try {
      await apiJson(`/app/admin/comms/api/accounts/${account.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo eliminar');
    } finally {
      setBusyId(null);
    }
  };

  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success('Copiado'))
      .catch(() => toast.error('No se pudo copiar'));

  return (
    <div className="assistant-admin-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 className="assistant-admin-section-title" style={{ margin: 0 }}>
          Números y bots
        </h3>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          aria-label="Actualizar"
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setEditing('new')}
        >
          <Plus size={14} /> Nueva cuenta
        </button>
      </div>
      <p className="assistant-admin-muted">
        Cada cuenta pertenece a uno o más equipos (roles). Solo los usuarios de esos roles ven sus
        conversaciones.
      </p>
      {loading && <div className="assistant-admin-loading">Cargando…</div>}
      {error && (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && accounts.length === 0 && (
        <div className="assistant-admin-empty">
          Aún no hay cuentas. Crea la primera para empezar a recibir mensajes.
        </div>
      )}
      {accounts.length > 0 && (
        <div className="assistant-admin-table-wrap">
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Canal</th>
                <th>Etiqueta</th>
                <th>Identificador</th>
                <th>Equipos</th>
                <th>Estado</th>
                <th>Credenciales</th>
                <th>Webhook</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{PROVIDER_LABELS[a.provider] ?? a.provider}</td>
                  <td>{a.label}</td>
                  <td>{a.identifier}</td>
                  <td>
                    {a.teamKeys.length ? (
                      a.teamKeys.map((k) => (
                        <span key={k} className="badge badge-weak" style={{ marginRight: 4 }}>
                          {k}
                        </span>
                      ))
                    ) : (
                      <span className="assistant-admin-muted">
                        Sin equipo (solo administradores)
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`assistant-admin-badge ${a.status === 'active' ? 'assistant-admin-badge-success' : ''}`}
                    >
                      {a.status === 'active' ? 'Activa' : 'Pausada'}
                    </span>
                  </td>
                  <td>
                    {a.hasConnection ? (
                      <span className="badge badge-success">Cifradas</span>
                    ) : (
                      <span className="badge badge-warning">Variables de entorno</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => copy(a.webhookUrl)}
                      aria-label="Copiar URL del webhook"
                      title={a.webhookUrl}
                    >
                      <Copy size={14} /> URL
                    </button>
                    {a.provider === 'telegram' && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === a.id}
                        onClick={() => void rotateSecret(a)}
                        aria-label="Rotar secreto de Telegram"
                        title="Genera un nuevo secret_token (se muestra una sola vez)"
                      >
                        <KeyRound size={14} />
                      </button>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="assistant-admin-test-btn"
                      disabled={busyId === a.id}
                      onClick={() => void test(a)}
                    >
                      <ShieldCheck size={14} /> Probar
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busyId === a.id}
                      onClick={() => setEditing(a)}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busyId === a.id}
                      onClick={() => void toggleStatus(a)}
                    >
                      {a.status === 'active' ? 'Pausar' : 'Activar'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busyId === a.id}
                      onClick={() => void remove(a)}
                      aria-label="Eliminar cuenta"
                    >
                      <Trash2 size={14} />
                    </button>
                    {testResult[a.id] && (
                      <div
                        className={`assistant-admin-test-result ${testResult[a.id].ok ? 'assistant-admin-success' : 'assistant-admin-error'}`}
                        style={{ marginTop: 4, whiteSpace: 'normal' }}
                      >
                        {testResult[a.id].detail}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Nueva cuenta' : 'Editar cuenta'}
        size="md"
      >
        {editing !== null && (
          <AccountForm
            roles={roles}
            account={editing === 'new' ? null : editing}
            onSaved={(result) => {
              setEditing(null);
              if (result.webhookSecret)
                setSecret({
                  label: result.account.label,
                  secret: result.webhookSecret,
                  webhookUrl: result.account.webhookUrl,
                });
              void load();
            }}
          />
        )}
      </Drawer>

      <Modal
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        title="Secreto del webhook de Telegram"
      >
        {secret && (
          <div style={{ display: 'grid', gap: 10 }}>
            <p>
              Guarda este secreto ahora: <strong>no se volverá a mostrar</strong>. Configúralo en
              Telegram con <code>setWebhook</code>:
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                background: 'var(--unik-bg)',
                padding: 8,
                borderRadius: 6,
              }}
            >
              {`https://api.telegram.org/bot<TOKEN>/setWebhook?url=${secret.webhookUrl}&secret_token=${secret.secret}`}
            </pre>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => copy(secret.secret)}
              >
                <Copy size={14} /> Copiar secreto
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => copy(secret.webhookUrl)}
              >
                <Copy size={14} /> Copiar URL
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AccountForm({
  roles,
  account,
  onSaved,
}: {
  roles: RoleOption[];
  account: CommAccountDTO | null;
  onSaved: (r: { account: CommAccountDTO; webhookSecret: string | null }) => void;
}) {
  const [provider, setProvider] = useState(account?.provider ?? 'twilio_whatsapp');
  const [label, setLabel] = useState(account?.label ?? '');
  const [identifier, setIdentifier] = useState(account?.identifier ?? '');
  const [teamKeys, setTeamKeys] = useState<string[]>(account?.teamKeys ?? []);
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isTelegram = provider === 'telegram';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const credentials = isTelegram
      ? botToken
        ? { botToken }
        : undefined
      : accountSid && authToken
        ? { accountSid, authToken }
        : undefined;
    try {
      if (account) {
        const data = await apiJson<{ account: CommAccountDTO; webhookSecret: string | null }>(
          `/app/admin/comms/api/accounts/${account.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ label, teamKeys, credentials }),
          }
        );
        onSaved(data);
      } else {
        const data = await apiJson<{ account: CommAccountDTO; webhookSecret: string | null }>(
          '/app/admin/comms/api/accounts',
          {
            method: 'POST',
            body: JSON.stringify({ provider, label, identifier, teamKeys, credentials }),
          }
        );
        onSaved(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      {error && (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-field">
        <label htmlFor="acc-provider">Proveedor</label>
        <select
          id="acc-provider"
          className="select"
          value={provider}
          disabled={Boolean(account)}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="twilio_whatsapp">WhatsApp (Twilio)</option>
          <option value="twilio_sms">SMS (Twilio)</option>
          <option value="telegram">Telegram (Bot API)</option>
        </select>
      </div>
      <div className="form-field">
        <label htmlFor="acc-label">Etiqueta</label>
        <input
          id="acc-label"
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          minLength={2}
          placeholder="Ventas Monterrey"
        />
      </div>
      <div className="form-field">
        <label htmlFor="acc-identifier">{isTelegram ? 'Usuario del bot' : 'Número (E.164)'}</label>
        <input
          id="acc-identifier"
          className="input"
          value={identifier}
          disabled={Boolean(account)}
          onChange={(e) => setIdentifier(e.target.value)}
          required
          placeholder={isTelegram ? 'unik_ventas_bot' : '+5281...'}
        />
      </div>
      <div className="form-field">
        <label>Equipos (roles) con acceso</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {roles.length === 0 && (
            <span className="assistant-admin-muted">No hay roles activos.</span>
          )}
          {roles.map((r) => (
            <label
              key={r.key}
              className="checkbox-row"
              style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={teamKeys.includes(r.key)}
                onChange={(e) =>
                  setTeamKeys((prev) =>
                    e.target.checked ? [...prev, r.key] : prev.filter((k) => k !== r.key)
                  )
                }
              />{' '}
              {r.name}
            </label>
          ))}
        </div>
      </div>
      <fieldset style={{ border: '1px solid var(--unik-border)', borderRadius: 8, padding: 10 }}>
        <legend>
          Credenciales{' '}
          {account
            ? '(dejar vacío para conservar)'
            : '(opcional: si faltan se usan las variables de entorno)'}
        </legend>
        {isTelegram ? (
          <div className="form-field">
            <label htmlFor="acc-bot">Token del bot</label>
            <input
              id="acc-bot"
              className="input"
              type="password"
              autoComplete="off"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
        ) : (
          <>
            <div className="form-field">
              <label htmlFor="acc-sid">Account SID</label>
              <input
                id="acc-sid"
                className="input"
                autoComplete="off"
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="acc-token">Auth Token</label>
              <input
                id="acc-token"
                className="input"
                type="password"
                autoComplete="off"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
            </div>
          </>
        )}
        <small className="assistant-admin-config-hint">
          Se cifran con la clave maestra del servidor y nunca vuelven al navegador.
        </small>
      </fieldset>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={saving || label.length < 2 || (!account && identifier.length < 2)}
      >
        {saving ? 'Guardando…' : account ? 'Guardar cambios' : 'Crear cuenta'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Responsibles                                                        */
/* ------------------------------------------------------------------ */

function ResponsiblesTab({ users }: { users: UserOption[] }) {
  const [rows, setRows] = useState<ResponsibleDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ResponsibleDTO | null | 'new'>(null);
  const [form, setForm] = useState({
    area: '',
    label: '',
    userId: '',
    backupUserId: '',
    description: '',
    active: true,
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson<{ responsibles: ResponsibleDTO[] }>(
        '/app/admin/comms/api/responsibles?all=1'
      );
      setRows(data.responsibles);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (r: ResponsibleDTO | 'new') => {
    setEditing(r);
    setForm(
      r === 'new'
        ? { area: '', label: '', userId: '', backupUserId: '', description: '', active: true }
        : {
            area: r.area,
            label: r.label,
            userId: r.userId,
            backupUserId: r.backupUserId ?? '',
            description: r.description ?? '',
            active: r.active,
          }
    );
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = JSON.stringify({
        ...form,
        backupUserId: form.backupUserId || null,
        description: form.description || null,
      });
      if (editing === 'new')
        await apiJson('/app/admin/comms/api/responsibles', { method: 'POST', body });
      else if (editing)
        await apiJson(`/app/admin/comms/api/responsibles/${editing.id}`, { method: 'PATCH', body });
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: ResponsibleDTO) => {
    if (!window.confirm(`¿Eliminar el responsable de "${r.label}"?`)) return;
    try {
      await apiJson(`/app/admin/comms/api/responsibles/${r.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo eliminar');
    }
  };

  return (
    <div className="assistant-admin-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 className="assistant-admin-section-title" style={{ margin: 0 }}>
          Directorio de responsables
        </h3>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => open('new')}
        >
          <Plus size={14} /> Nuevo responsable
        </button>
      </div>
      <p className="assistant-admin-muted">
        Directorio de responsables por área para la bandeja y el asistente; si el titular está
        inactivo se usa el respaldo.
      </p>
      {loading && <div className="assistant-admin-loading">Cargando…</div>}
      {error && (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div className="assistant-admin-empty">Sin responsables configurados.</div>
      )}
      {rows.length > 0 && (
        <div className="assistant-admin-table-wrap">
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Área</th>
                <th>Etiqueta</th>
                <th>Titular</th>
                <th>Respaldo</th>
                <th>Activo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.area}</code>
                  </td>
                  <td>{r.label}</td>
                  <td>{r.userName ?? r.userId}</td>
                  <td>{r.backupUserName ?? '—'}</td>
                  <td>{r.active ? 'Sí' : 'No'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(r)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void remove(r)}
                      aria-label="Eliminar"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Nuevo responsable' : 'Editar responsable'}
        size="md"
      >
        <form onSubmit={save} style={{ display: 'grid', gap: 12 }}>
          <div className="form-field">
            <label htmlFor="resp-area">Área (clave)</label>
            <input
              id="resp-area"
              className="input"
              value={form.area}
              onChange={(e) => setForm({ ...form, area: e.target.value })}
              required
              placeholder="ventas, instalaciones, cobranza…"
            />
          </div>
          <div className="form-field">
            <label htmlFor="resp-label">Etiqueta</label>
            <input
              id="resp-label"
              className="input"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="resp-user">Titular</label>
            <select
              id="resp-user"
              className="select"
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
              required
            >
              <option value="">Elegir…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="resp-backup">Respaldo</label>
            <select
              id="resp-backup"
              className="select"
              value={form.backupUserId}
              onChange={(e) => setForm({ ...form, backupUserId: e.target.value })}
            >
              <option value="">Sin respaldo</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="resp-desc">Descripción</label>
            <input
              id="resp-desc"
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <label className="checkbox-row" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />{' '}
            Activo
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !form.area || !form.label || !form.userId}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </form>
      </Drawer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

function DuplicatesTab() {
  const [rows, setRows] = useState<DuplicateCandidateDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson<{ duplicates: DuplicateCandidateDTO[] }>(
        '/app/inbox/api/contacts/duplicates'
      );
      setRows(data.duplicates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: 'merge' | 'dismiss') => {
    setBusy(id);
    try {
      await apiJson(`/app/inbox/api/contacts/duplicates/${id}/${action}`, {
        method: 'POST',
        body: '{}',
      });
      toast.success(action === 'merge' ? 'Contactos fusionados' : 'Marcado como distinto');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo aplicar');
    } finally {
      setBusy(null);
    }
  };

  const describe = (c: DuplicateCandidateDTO['contact']) =>
    [c.phone, c.email, c.telegramId ? `tg:${c.telegramId}` : null].filter(Boolean).join(' · ');

  return (
    <div className="assistant-admin-section">
      <h3 className="assistant-admin-section-title">Posibles contactos duplicados</h3>
      <p className="assistant-admin-muted">
        Detectados por teléfono, correo o nombre + dominio. Nada se fusiona sin tu confirmación; al
        fusionar, las conversaciones y compromisos pasan al contacto sobreviviente.
      </p>
      {loading && <div className="assistant-admin-loading">Cargando…</div>}
      {error && (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div className="assistant-admin-empty">No hay duplicados pendientes de revisión.</div>
      )}
      <div className="assistant-admin-list">
        {rows.map((d) => (
          <div
            key={d.contact.id}
            className="assistant-admin-list-item"
            style={{ alignItems: 'flex-start' }}
          >
            <div style={{ flex: 1 }}>
              <div className="assistant-admin-list-name">
                {d.contact.displayName}{' '}
                <span className="assistant-admin-muted">({describe(d.contact)})</span>
              </div>
              <div className="assistant-admin-list-meta">
                {d.suspected ? (
                  <>
                    Parece el mismo que <strong>{d.suspected.displayName}</strong> (
                    {describe(d.suspected)})
                  </>
                ) : (
                  'Sin contacto sospechoso vinculado'
                )}
                {d.reasons.length > 0 && <> · {d.reasons.join(', ')}</>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy === d.contact.id || !d.suspected}
                onClick={() => void act(d.contact.id, 'merge')}
              >
                Fusionar
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy === d.contact.id}
                onClick={() => void act(d.contact.id, 'dismiss')}
              >
                Son distintos
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
