'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { CatalogView } from '@/modules/areas/contabilidad/queries';
import { formatMoney } from '@/modules/areas/contabilidad/contabilidad-model';
import { AREA_KEYS, AREA_LABELS } from '@/modules/operations/types';
import {
  CASH_ACCOUNT_KINDS,
  CASH_ACCOUNT_KIND_LABELS,
  CATEGORY_KINDS,
  CATEGORY_KIND_LABELS,
} from '@/modules/finance/types';
import {
  createCashAccountCommand,
  createCategoryCommand,
  createCostCenterCommand,
  createEmployeeCommand,
  normalizeCatalogKey,
  updateCashAccountCommand,
  updateCategoryCommand,
  updateCostCenterCommand,
  updateEmployeeCommand,
} from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Catálogos de Contabilidad (plan 6.4): cuentas de caja y banco, categorías,
 * centros de costo y el directorio de empleados.
 *
 * Nada se borra: una cuenta se cierra, una categoría o un centro se archivan y
 * un empleado se da de baja, de modo que los asientos viejos siguen teniendo
 * sentido. La llave se normaliza para que el catálogo sea estable.
 */

export interface CatalogPanelProps {
  user: { id: string; name: string };
  view: CatalogView;
}

export function CatalogPanel({ user, view }: CatalogPanelProps) {
  const router = useRouter();
  const { run, busy, online } = useFinanceCommand(user.id);
  const [account, setAccount] = useState({ name: '', kind: 'bank', openingBalance: '' });
  const [category, setCategory] = useState({ name: '', kind: 'expense' });
  const [center, setCenter] = useState({ name: '', areaKey: '' });
  const [employee, setEmployee] = useState({
    name: '',
    position: '',
    costCenterId: '',
    userId: '',
    areaKey: '',
  });
  // Empleado en edición: ligar o desligar su cuenta y cambiar su área (plan 6.0).
  const [editing, setEditing] = useState<{ id: string; userId: string; areaKey: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const canManage = view.capabilities.manageCatalog;
  const canPayroll = view.capabilities.payroll;

  async function send(command: Parameters<typeof run>[0], message: string) {
    const result = await run(command, message);
    if (result.ok) router.refresh();
    return result.ok;
  }

  async function addAccount() {
    if (account.name.trim().length < 2) {
      setError('Escribe el nombre de la cuenta');
      return;
    }
    setError(null);
    const ok = await send(
      createCashAccountCommand({
        key: normalizeCatalogKey(account.name),
        name: account.name,
        kind: account.kind,
        ...(account.openingBalance ? { openingBalance: account.openingBalance } : {}),
      }),
      'Cuenta creada'
    );
    if (ok) setAccount({ name: '', kind: 'bank', openingBalance: '' });
  }

  async function addCategory() {
    if (category.name.trim().length < 2) {
      setError('Escribe el nombre de la categoría');
      return;
    }
    setError(null);
    const ok = await send(
      createCategoryCommand({
        key: normalizeCatalogKey(category.name),
        name: category.name,
        kind: category.kind,
      }),
      'Categoría creada'
    );
    if (ok) setCategory({ name: '', kind: 'expense' });
  }

  async function addCenter() {
    if (center.name.trim().length < 2) {
      setError('Escribe el nombre del centro de costo');
      return;
    }
    setError(null);
    const ok = await send(
      createCostCenterCommand({
        key: normalizeCatalogKey(center.name),
        name: center.name,
        areaKey: center.areaKey || null,
      }),
      'Centro de costo creado'
    );
    if (ok) setCenter({ name: '', areaKey: '' });
  }

  async function addEmployee() {
    if (employee.name.trim().length < 2) {
      setError('Escribe el nombre del empleado');
      return;
    }
    setError(null);
    const ok = await send(
      createEmployeeCommand({
        name: employee.name,
        position: employee.position || null,
        costCenterId: employee.costCenterId || null,
        userId: employee.userId || null,
        areaKey: employee.areaKey || null,
      }),
      'Empleado dado de alta'
    );
    if (ok) setEmployee({ name: '', position: '', costCenterId: '', userId: '', areaKey: '' });
  }

  async function saveEmployeeLink() {
    if (!editing) return;
    setError(null);
    const ok = await send(
      // `null` desliga: el servicio distingue «vacío» de «no lo toques».
      updateEmployeeCommand(editing.id, {
        userId: editing.userId || null,
        areaKey: editing.areaKey || null,
      }),
      'Empleado actualizado'
    );
    if (ok) setEditing(null);
  }

  return (
    <div className="fin-page">
      {!online ? (
        <Alert variant="info">Sin conexión: los cambios del catálogo se enviarán al volver.</Alert>
      ) : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      {!canManage ? (
        <Alert variant="info">
          Puedes consultar los catálogos; crearlos o archivarlos necesita el permiso de catálogo.
        </Alert>
      ) : null}

      <section className="fin-card" aria-labelledby="fin-accounts-title">
        <h2 className="fin-card-title" id="fin-accounts-title">
          Cuentas de caja y banco
        </h2>
        {canManage ? (
          <div className="fin-fields">
            <FormField label="Nombre" htmlFor="fin-account-name">
              <Input
                id="fin-account-name"
                value={account.name}
                onChange={(event) => setAccount({ ...account, name: event.target.value })}
              />
            </FormField>
            <FormField label="Tipo" htmlFor="fin-account-kind">
              <Select
                id="fin-account-kind"
                value={account.kind}
                onChange={(event) => setAccount({ ...account, kind: event.target.value })}
              >
                {CASH_ACCOUNT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {CASH_ACCOUNT_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Saldo inicial"
              htmlFor="fin-account-opening"
              help="Se registra como asiento de apertura."
            >
              <Input
                id="fin-account-opening"
                inputMode="decimal"
                value={account.openingBalance}
                onChange={(event) => setAccount({ ...account, openingBalance: event.target.value })}
              />
            </FormField>
            <div className="fin-field-wide fin-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={addAccount}>
                Crear cuenta
              </Button>
            </div>
          </div>
        ) : null}

        <ul className="fin-cards" style={{ display: 'grid' }}>
          {view.accounts.map((item) => (
            <li key={item.id} className="fin-row-card">
              <span className="fin-row-card-head">
                <span className="fin-row-card-title">{item.name}</span>
                <span className="fin-num">{formatMoney(item.currentBalance, item.currency)}</span>
              </span>
              <span className="fin-muted">
                {item.kindLabel} · {item.key}
                {item.status === 'active' ? '' : ' · cerrada'}
              </span>
              {canManage ? (
                <span className="fin-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      send(
                        updateCashAccountCommand(item.id, item.version, {
                          status: item.status === 'active' ? 'closed' : 'active',
                        }),
                        item.status === 'active' ? 'Cuenta cerrada' : 'Cuenta reabierta'
                      )
                    }
                  >
                    {item.status === 'active' ? 'Cerrar' : 'Reabrir'}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="fin-card" aria-labelledby="fin-categories-title">
        <h2 className="fin-card-title" id="fin-categories-title">
          Categorías
        </h2>
        {canManage ? (
          <div className="fin-fields">
            <FormField label="Nombre" htmlFor="fin-category-name">
              <Input
                id="fin-category-name"
                value={category.name}
                onChange={(event) => setCategory({ ...category, name: event.target.value })}
              />
            </FormField>
            <FormField label="Tipo" htmlFor="fin-category-kind">
              <Select
                id="fin-category-kind"
                value={category.kind}
                onChange={(event) => setCategory({ ...category, kind: event.target.value })}
              >
                {CATEGORY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {CATEGORY_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="fin-field-wide fin-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={addCategory}>
                Crear categoría
              </Button>
            </div>
          </div>
        ) : null}

        <div className="fin-table-wrap">
          <table className="fin-table">
            <caption className="sr-only">Categorías de ingreso y gasto</caption>
            <thead>
              <tr>
                <th scope="col">Nombre</th>
                <th scope="col">Tipo</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {view.categories.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.kindLabel}</td>
                  <td>
                    <Badge variant={item.status === 'active' ? 'success' : 'weak'}>
                      {item.status === 'active' ? 'Activa' : 'Archivada'}
                    </Badge>
                  </td>
                  <td>
                    {canManage ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          send(
                            updateCategoryCommand(item.id, {
                              status: item.status === 'active' ? 'archived' : 'active',
                            }),
                            item.status === 'active'
                              ? 'Categoría archivada'
                              : 'Categoría reactivada'
                          )
                        }
                      >
                        {item.status === 'active' ? 'Archivar' : 'Reactivar'}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="fin-cards">
          {view.categories.map((item) => (
            <li key={`card-${item.id}`} className="fin-row-card">
              <span className="fin-row-card-head">
                <span className="fin-row-card-title">{item.name}</span>
                <span className="fin-muted">{item.kindLabel}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="fin-card" aria-labelledby="fin-centers-title">
        <h2 className="fin-card-title" id="fin-centers-title">
          Centros de costo
        </h2>
        {canManage ? (
          <div className="fin-fields">
            <FormField label="Nombre" htmlFor="fin-center-name">
              <Input
                id="fin-center-name"
                value={center.name}
                onChange={(event) => setCenter({ ...center, name: event.target.value })}
              />
            </FormField>
            <FormField label="Área" htmlFor="fin-center-area">
              <Select
                id="fin-center-area"
                value={center.areaKey}
                onChange={(event) => setCenter({ ...center, areaKey: event.target.value })}
              >
                <option value="">Sin área</option>
                {AREA_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {AREA_LABELS[key]}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="fin-field-wide fin-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={addCenter}>
                Crear centro
              </Button>
            </div>
          </div>
        ) : null}

        <ul className="fin-cards" style={{ display: 'grid' }}>
          {view.costCenters.map((item) => (
            <li key={item.id} className="fin-row-card">
              <span className="fin-row-card-head">
                <span className="fin-row-card-title">{item.name}</span>
                <span className="fin-muted">
                  {item.areaKey
                    ? AREA_LABELS[item.areaKey as keyof typeof AREA_LABELS]
                    : 'Sin área'}
                </span>
              </span>
              {canManage ? (
                <span className="fin-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      send(
                        updateCostCenterCommand(item.id, {
                          status: item.status === 'active' ? 'archived' : 'active',
                        }),
                        item.status === 'active' ? 'Centro archivado' : 'Centro reactivado'
                      )
                    }
                  >
                    {item.status === 'active' ? 'Archivar' : 'Reactivar'}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="fin-card" aria-labelledby="fin-employees-title">
        <h2 className="fin-card-title" id="fin-employees-title">
          Empleados
        </h2>
        {canPayroll ? (
          <div className="fin-fields">
            <FormField label="Nombre" htmlFor="fin-employee-name">
              <Input
                id="fin-employee-name"
                value={employee.name}
                onChange={(event) => setEmployee({ ...employee, name: event.target.value })}
              />
            </FormField>
            <FormField label="Puesto" htmlFor="fin-employee-position">
              <Input
                id="fin-employee-position"
                value={employee.position}
                onChange={(event) => setEmployee({ ...employee, position: event.target.value })}
              />
            </FormField>
            <FormField label="Centro de costo" htmlFor="fin-employee-center">
              <Select
                id="fin-employee-center"
                value={employee.costCenterId}
                onChange={(event) => setEmployee({ ...employee, costCenterId: event.target.value })}
              >
                <option value="">Sin centro</option>
                {view.costCenters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Área"
              htmlFor="fin-employee-area"
              help="A qué área pertenece; se usa para el presupuesto y la nómina por área."
            >
              <Select
                id="fin-employee-area"
                value={employee.areaKey}
                onChange={(event) => setEmployee({ ...employee, areaKey: event.target.value })}
              >
                <option value="">Sin área</option>
                {AREA_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {AREA_LABELS[key]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Cuenta del sistema"
              htmlFor="fin-employee-user"
              help="No todo empleado tiene acceso al sistema: déjalo en «Sin cuenta» cuando no lo tenga."
            >
              <Select
                id="fin-employee-user"
                value={employee.userId}
                onChange={(event) => setEmployee({ ...employee, userId: event.target.value })}
              >
                <option value="">Sin cuenta</option>
                {view.employeeUsers.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={option.takenByEmployeeId !== null}
                  >
                    {option.name} ({option.username})
                    {option.takenByEmployeeId ? ' · ya ligada' : ''}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="fin-field-wide fin-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={addEmployee}>
                Dar de alta
              </Button>
            </div>
          </div>
        ) : null}

        {view.employees.length === 0 ? (
          <p className="fin-card-hint">Todavía no hay empleados en el directorio.</p>
        ) : (
          <ul className="fin-cards" style={{ display: 'grid' }}>
            {view.employees.map((item) => {
              const account = view.employeeUsers.find((option) => option.id === item.userId);
              const areaLabel = item.areaKey
                ? (AREA_LABELS[item.areaKey as keyof typeof AREA_LABELS] ?? item.areaKey)
                : 'Sin área';
              const isEditing = editing?.id === item.id;
              return (
                <li key={item.id} className="fin-row-card">
                  <span className="fin-row-card-head">
                    <span className="fin-row-card-title">
                      {item.number} · {item.name}
                    </span>
                    <Badge variant={item.active ? 'success' : 'weak'}>
                      {item.active ? 'Activo' : 'Baja'}
                    </Badge>
                  </span>
                  <span className="fin-muted">
                    {item.position ?? 'Sin puesto'} · {areaLabel} ·{' '}
                    {item.userId
                      ? `Cuenta: ${account ? `${account.name} (${account.username})` : item.userId}`
                      : 'Sin cuenta del sistema'}
                  </span>
                  {isEditing && canPayroll ? (
                    <div className="fin-fields">
                      <FormField label="Área" htmlFor={`fin-employee-area-${item.id}`}>
                        <Select
                          id={`fin-employee-area-${item.id}`}
                          value={editing.areaKey}
                          onChange={(event) =>
                            setEditing({ ...editing, areaKey: event.target.value })
                          }
                        >
                          <option value="">Sin área</option>
                          {AREA_KEYS.map((key) => (
                            <option key={key} value={key}>
                              {AREA_LABELS[key]}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <FormField
                        label="Cuenta del sistema"
                        htmlFor={`fin-employee-user-${item.id}`}
                        help="Una cuenta pertenece a un solo empleado."
                      >
                        <Select
                          id={`fin-employee-user-${item.id}`}
                          value={editing.userId}
                          onChange={(event) =>
                            setEditing({ ...editing, userId: event.target.value })
                          }
                        >
                          <option value="">Sin cuenta</option>
                          {view.employeeUsers.map((option) => (
                            <option
                              key={option.id}
                              value={option.id}
                              disabled={
                                option.takenByEmployeeId !== null &&
                                option.takenByEmployeeId !== item.id
                              }
                            >
                              {option.name} ({option.username})
                              {option.takenByEmployeeId && option.takenByEmployeeId !== item.id
                                ? ' · ya ligada'
                                : ''}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <div className="fin-field-wide fin-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy}
                          onClick={saveEmployeeLink}
                        >
                          Guardar
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {canPayroll ? (
                    <span className="fin-actions">
                      {!isEditing ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setEditing({
                              id: item.id,
                              userId: item.userId ?? '',
                              areaKey: item.areaKey ?? '',
                            })
                          }
                        >
                          Cuenta y área
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          send(
                            updateEmployeeCommand(item.id, { active: !item.active }),
                            item.active ? 'Empleado dado de baja' : 'Empleado reactivado'
                          )
                        }
                      >
                        {item.active ? 'Dar de baja' : 'Reactivar'}
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
