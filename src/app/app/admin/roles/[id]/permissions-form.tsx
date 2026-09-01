'use client';

import { useActionState } from 'react';
import { savePermissionsAction, SimpleFormState } from '../actions';

export interface PermissionGroupView {
  group: string;
  permissions: { key: string; label: string; description: string }[];
}

const simpleInitial: SimpleFormState = { error: null, success: false };

export function PermissionsForm({
  roleId,
  groups,
  assignedKeys,
  readOnly,
}: {
  roleId: string;
  groups: PermissionGroupView[];
  assignedKeys: string[];
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState(savePermissionsAction, simpleInitial);
  const assigned = new Set(assignedKeys);

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state.success ? <div className="alert alert-success">Permisos actualizados.</div> : null}

      <input type="hidden" name="roleId" value={roleId} />

      {groups.map((group) => (
        <div key={group.group} className="permission-group">
          <h3>{group.group}</h3>
          {group.permissions.map((permission) => (
            <label key={permission.key} className="checkbox-row">
              <input
                type="checkbox"
                name="permissionKeys"
                value={permission.key}
                defaultChecked={assigned.has(permission.key)}
                disabled={readOnly}
              />
              <span>
                {permission.label}{' '}
                <span className="muted">
                  — {permission.description} (<span className="mono">{permission.key}</span>)
                </span>
              </span>
            </label>
          ))}
        </div>
      ))}

      {readOnly ? null : (
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar permisos'}
        </button>
      )}
    </form>
  );
}
