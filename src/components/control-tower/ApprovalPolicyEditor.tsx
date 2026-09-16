'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
} from '@/components/ui/primitives';
import type { ApprovalScope } from '@/modules/operations/types';
import {
  APPROVAL_POLICY_SCOPES,
  APPROVAL_POLICY_SCOPE_HINTS,
  APPROVAL_POLICY_SCOPE_LABELS,
  EMPTY_POLICY_FORM,
  POLICY_CURRENCIES,
  describeRequiredSignatures,
  formatPolicyAmount,
  overlappingPolicyWarnings,
  policyRangeLabel,
  policyToForm,
  scopesUsingDefaults,
  sortPolicies,
  type ApprovalPolicyFormInput,
  type ApprovalPolicyRow,
  type PolicyPreview,
} from './policy-model';

/**
 * Approval policies by scope, category, amount, signatures and roles (plan 7.7
 * `configuración`, model `ApprovalPolicy`).
 *
 * The screen never decides an approval: it stores rules and asks the engine
 * what it WOULD do with them. The preview calls
 * `resolveApprovalRequirement` + `findEligibleApprovers` on the server, so what
 * it promises is literally what `requestApproval` would resolve.
 *
 * A scope without a single active rule falls back to the defaults derived from
 * the approval thresholds of the operations configuration; that is stated out
 * loud instead of showing an empty table that looks broken.
 */

export interface ApprovalPolicyEditorProps {
  policies: ApprovalPolicyRow[];
  roles: Array<{ key: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  /** Server actions bound by the page; each re-checks `operations.admin`. */
  savePolicyAction: (input: {
    id: string | null;
    form: ApprovalPolicyFormInput;
  }) => Promise<{ success: boolean; error: string | null; policies: ApprovalPolicyRow[] | null }>;
  deletePolicyAction: (
    id: string
  ) => Promise<{ success: boolean; error: string | null; policies: ApprovalPolicyRow[] | null }>;
  previewPolicyAction: (input: {
    scope: ApprovalScope;
    amount: string;
    currency: string;
    categoryId: string;
  }) => Promise<{ success: boolean; error: string | null; preview: PolicyPreview | null }>;
  /** Defaults in force while a scope has no active policy. */
  thresholds: { procurementDoubleApprovalMxn: number; expenseAutoApproveMxn: number };
}

interface EditorState {
  id: string | null;
  form: ApprovalPolicyFormInput;
}

function approvalExpiryLabel(minutes: number): string {
  const labels: Record<number, string> = {
    30: '30 min',
    60: '1 h',
    120: '2 h',
    360: '6 h',
    720: '12 h',
    1440: '24 h',
    2880: '48 h',
    4320: '72 h',
    10080: '7 días',
  };
  return labels[minutes] ?? `${minutes} min`;
}

export function ApprovalPolicyEditor({
  policies,
  roles,
  categories,
  savePolicyAction,
  deletePolicyAction,
  previewPolicyAction,
  thresholds,
}: ApprovalPolicyEditorProps) {
  const [rows, setRows] = useState(policies);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [removing, setRemoving] = useState<ApprovalPolicyRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewInput, setPreviewInput] = useState({
    scope: 'expense' as ApprovalScope,
    amount: '5000',
    currency: 'MXN',
    categoryId: '',
  });
  const [previewPending, startPreview] = useTransition();

  const sorted = useMemo(() => sortPolicies(rows), [rows]);
  const warnings = useMemo(() => overlappingPolicyWarnings(rows), [rows]);
  const defaults = useMemo(() => scopesUsingDefaults(rows), [rows]);
  const categoryName = useCallback(
    (id: string | null) => (id ? (categories.find((row) => row.id === id)?.name ?? id) : null),
    [categories]
  );

  const save = useCallback(() => {
    if (!editor) return;
    setFormError(null);
    startTransition(async () => {
      const outcome = await savePolicyAction({ id: editor.id, form: editor.form });
      if (!outcome.success || !outcome.policies) {
        setFormError(outcome.error ?? 'No pudimos guardar la política');
        return;
      }
      setRows(outcome.policies);
      setEditor(null);
      toast.success(editor.id ? 'Política actualizada' : 'Política creada');
    });
  }, [editor, savePolicyAction]);

  const remove = useCallback(() => {
    if (!removing) return;
    startTransition(async () => {
      const outcome = await deletePolicyAction(removing.id);
      if (!outcome.success || !outcome.policies) {
        toast.error(outcome.error ?? 'No pudimos borrar la política');
        return;
      }
      setRows(outcome.policies);
      setRemoving(null);
      toast.success('Política borrada');
    });
  }, [removing, deletePolicyAction]);

  const runPreview = useCallback(() => {
    setPreviewError(null);
    startPreview(async () => {
      const outcome = await previewPolicyAction(previewInput);
      if (!outcome.success || !outcome.preview) {
        setPreview(null);
        setPreviewError(outcome.error ?? 'No pudimos calcular la vista previa');
        return;
      }
      setPreview(outcome.preview);
    });
  }, [previewInput, previewPolicyAction]);

  return (
    <div className="ct-settings">
      <ChartCard
        title="Políticas de aprobación"
        description="Quién firma, desde qué importe y cuántas firmas hacen falta en cada alcance."
        height="auto"
        actions={
          <Button size="sm" onClick={() => setEditor({ id: null, form: { ...EMPTY_POLICY_FORM } })}>
            <Plus size={14} aria-hidden="true" />
            Nueva política
          </Button>
        }
      >
        {warnings.length > 0 ? (
          <Alert variant="warning" title="Hay rangos que se enciman">
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {defaults.length > 0 ? (
          <Alert variant="info" title="Alcances sin política propia">
            {defaults.map((scope) => APPROVAL_POLICY_SCOPE_LABELS[scope]).join(', ')}. Usan los
            valores por omisión: doble firma desde{' '}
            {formatPolicyAmount(thresholds.procurementDoubleApprovalMxn, 'MXN')} y gasto sin firma
            hasta {formatPolicyAmount(thresholds.expenseAutoApproveMxn, 'MXN')}.
          </Alert>
        ) : null}

        {sorted.length === 0 ? (
          <div className="ct-empty">
            <strong>Sin políticas propias</strong>
            <p>
              Toda la empresa usa los valores por omisión de la configuración. Crea una política
              cuando un alcance necesite otro umbral, otra cantidad de firmas o roles concretos.
            </p>
          </div>
        ) : (
          <div className="ct-table-scroll">
            <table className="table">
              <caption className="sr-only">Políticas de aprobación configuradas</caption>
              <thead>
                <tr>
                  <th scope="col">Alcance</th>
                  <th scope="col">Rango</th>
                  <th scope="col">Categoría</th>
                  <th scope="col">Firmas</th>
                  <th scope="col">Vence</th>
                  <th scope="col">Roles aprobadores</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="ct-cell-strong">
                      {APPROVAL_POLICY_SCOPE_LABELS[row.scope]}
                    </th>
                    <td>
                      {policyRangeLabel(row.minAmount, row.maxAmount, row.currency)}
                      <span className="ct-cell-sub">{row.currency}</span>
                    </td>
                    <td>
                      {row.categoryLabel ?? categoryName(row.categoryId) ?? (
                        <span className="text-muted">Todas</span>
                      )}
                    </td>
                    <td className="ct-numeric">
                      {describeRequiredSignatures(row.requiredApprovals)}
                    </td>
                    <td>
                      {row.expiresAfterMinutes
                        ? approvalExpiryLabel(row.expiresAfterMinutes)
                        : 'Plazo general'}
                    </td>
                    <td>
                      {row.approverRoleKeys.length === 0 ? (
                        <span className="text-muted">Por permiso del alcance</span>
                      ) : (
                        row.approverRoleKeys
                          .map((key) => roles.find((role) => role.key === key)?.name ?? key)
                          .join(', ')
                      )}
                    </td>
                    <td>
                      <Badge variant={row.active ? 'success' : 'weak'}>
                        {row.active ? 'Activa' : 'Inactiva'}
                      </Badge>
                    </td>
                    <td>
                      <span className="ct-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Editar la política de ${APPROVAL_POLICY_SCOPE_LABELS[row.scope]}`}
                          onClick={() => setEditor({ id: row.id, form: policyToForm(row) })}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          Editar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Borrar la política de ${APPROVAL_POLICY_SCOPE_LABELS[row.scope]}`}
                          onClick={() => setRemoving(row)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          Borrar
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>

      <ChartCard
        title="¿A quién le pediría firma?"
        description="Pregúntale al motor, con las políticas guardadas, qué haría con un importe concreto."
        height="auto"
      >
        <div className="ct-filters">
          <div className="ct-filter">
            <label htmlFor="ct-preview-scope">Alcance</label>
            <Select
              id="ct-preview-scope"
              value={previewInput.scope}
              onChange={(event) =>
                setPreviewInput((state) => ({
                  ...state,
                  scope: event.target.value as ApprovalScope,
                }))
              }
            >
              {APPROVAL_POLICY_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {APPROVAL_POLICY_SCOPE_LABELS[scope]}
                </option>
              ))}
            </Select>
          </div>
          <div className="ct-filter">
            <label htmlFor="ct-preview-amount">Importe</label>
            <Input
              id="ct-preview-amount"
              type="number"
              min={0}
              inputMode="decimal"
              value={previewInput.amount}
              onChange={(event) =>
                setPreviewInput((state) => ({ ...state, amount: event.target.value }))
              }
            />
          </div>
          <div className="ct-filter">
            <label htmlFor="ct-preview-currency">Moneda</label>
            <Select
              id="ct-preview-currency"
              value={previewInput.currency}
              onChange={(event) =>
                setPreviewInput((state) => ({ ...state, currency: event.target.value }))
              }
            >
              {POLICY_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </Select>
          </div>
          <div className="ct-filter">
            <label htmlFor="ct-preview-category">Categoría</label>
            <Select
              id="ct-preview-category"
              value={previewInput.categoryId}
              onChange={(event) =>
                setPreviewInput((state) => ({ ...state, categoryId: event.target.value }))
              }
            >
              <option value="">Cualquiera</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="ct-actions">
            <Button size="sm" onClick={runPreview} disabled={previewPending}>
              <Wand2 size={14} aria-hidden="true" />
              {previewPending ? 'Calculando…' : 'Ver vista previa'}
            </Button>
          </div>
        </div>

        {previewError ? <Alert variant="error">{previewError}</Alert> : null}

        {preview ? (
          <div className="ct-policy-preview">
            <p>
              <strong>{preview.summary}</strong>
            </p>
            <p>
              {preview.fromDefaults
                ? 'No hay política guardada para este caso.'
                : `Política aplicada: ${preview.policyId}`}{' '}
              · {describeRequiredSignatures(preview.requiredApprovals)}
            </p>
            {preview.approvers.length > 0 ? (
              <p>Personas elegibles: {preview.approvers.map((person) => person.name).join(', ')}</p>
            ) : (
              <p>Ninguna persona elegible con las reglas actuales.</p>
            )}
            {preview.warning ? <Alert variant="warning">{preview.warning}</Alert> : null}
          </div>
        ) : null}
      </ChartCard>

      {editor ? (
        <Dialog open onOpenChange={(open) => (!open && !pending ? setEditor(null) : undefined)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{editor.id ? 'Editar política' : 'Nueva política'}</DialogTitle>
              <DialogDescription>
                {APPROVAL_POLICY_SCOPE_HINTS[editor.form.scope as ApprovalScope]}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3">
              <FormField label="Alcance" htmlFor="ct-policy-scope">
                <Select
                  id="ct-policy-scope"
                  value={editor.form.scope}
                  onChange={(event) =>
                    setEditor((state) =>
                      state
                        ? {
                            ...state,
                            form: { ...state.form, scope: event.target.value as ApprovalScope },
                          }
                        : state
                    )
                  }
                >
                  {APPROVAL_POLICY_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {APPROVAL_POLICY_SCOPE_LABELS[scope]}
                    </option>
                  ))}
                </Select>
              </FormField>

              <div className="ct-settings-grid">
                <FormField label="Desde (importe)" htmlFor="ct-policy-min">
                  <Input
                    id="ct-policy-min"
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={editor.form.minAmount ?? '0'}
                    onChange={(event) =>
                      setEditor((state) =>
                        state
                          ? { ...state, form: { ...state.form, minAmount: event.target.value } }
                          : state
                      )
                    }
                  />
                </FormField>
                <FormField
                  label="Hasta (vacío = sin tope)"
                  htmlFor="ct-policy-max"
                  help="El rango es [desde, hasta): el tope no se incluye."
                >
                  <Input
                    id="ct-policy-max"
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={editor.form.maxAmount ?? ''}
                    onChange={(event) =>
                      setEditor((state) =>
                        state
                          ? { ...state, form: { ...state.form, maxAmount: event.target.value } }
                          : state
                      )
                    }
                  />
                </FormField>
                <FormField label="Moneda" htmlFor="ct-policy-currency">
                  <Select
                    id="ct-policy-currency"
                    value={editor.form.currency ?? 'MXN'}
                    onChange={(event) =>
                      setEditor((state) =>
                        state
                          ? {
                              ...state,
                              form: {
                                ...state.form,
                                currency: event.target.value as (typeof POLICY_CURRENCIES)[number],
                              },
                            }
                          : state
                      )
                    }
                  >
                    {POLICY_CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label="Firmas necesarias"
                  htmlFor="ct-policy-signatures"
                  help="0 = se aprueba solo. 2 o más exigen personas distintas."
                >
                  <Input
                    id="ct-policy-signatures"
                    type="number"
                    min={0}
                    max={5}
                    inputMode="numeric"
                    value={String(editor.form.requiredApprovals ?? 1)}
                    onChange={(event) =>
                      setEditor((state) =>
                        state
                          ? {
                              ...state,
                              form: {
                                ...state.form,
                                requiredApprovals: Number(event.target.value),
                              },
                            }
                          : state
                      )
                    }
                  />
                </FormField>
                <FormField
                  label="Plazo de esta política"
                  htmlFor="ct-policy-expiry"
                  help="General usa el plazo configurado para toda la operación."
                >
                  <Select
                    id="ct-policy-expiry"
                    value={String(editor.form.expiresAfterMinutes ?? 0)}
                    onChange={(event) =>
                      setEditor((state) =>
                        state
                          ? {
                              ...state,
                              form: {
                                ...state.form,
                                expiresAfterMinutes: Number(event.target.value),
                              },
                            }
                          : state
                      )
                    }
                  >
                    <option value="0">Usar plazo general</option>
                    <option value="30">30 min</option>
                    <option value="60">1 h</option>
                    <option value="120">2 h</option>
                    <option value="360">6 h</option>
                    <option value="720">12 h</option>
                    <option value="1440">24 h</option>
                    <option value="2880">48 h</option>
                    <option value="4320">72 h</option>
                    <option value="10080">7 días</option>
                  </Select>
                </FormField>
              </div>

              <FormField
                label="Categoría (opcional)"
                htmlFor="ct-policy-category"
                help="Una política con categoría gana sobre la general del mismo rango."
              >
                <Select
                  id="ct-policy-category"
                  value={editor.form.categoryId ?? ''}
                  onChange={(event) =>
                    setEditor((state) =>
                      state
                        ? { ...state, form: { ...state.form, categoryId: event.target.value } }
                        : state
                    )
                  }
                >
                  <option value="">Todas las categorías</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField
                label="Roles aprobadores (opcional)"
                help="Sin roles, aprueba quien tenga el permiso del alcance, operations.admin o super_admin."
              >
                <div className="ct-role-list">
                  {roles.length === 0 ? (
                    <span className="text-muted text-sm">No hay roles activos.</span>
                  ) : (
                    roles.map((role) => (
                      <Checkbox
                        key={role.key}
                        label={role.name}
                        checked={(editor.form.approverRoleKeys ?? []).includes(role.key)}
                        onChange={(event) =>
                          setEditor((state) => {
                            if (!state) return state;
                            const keys = new Set(state.form.approverRoleKeys ?? []);
                            if (event.target.checked) keys.add(role.key);
                            else keys.delete(role.key);
                            return {
                              ...state,
                              form: { ...state.form, approverRoleKeys: [...keys] },
                            };
                          })
                        }
                      />
                    ))
                  )}
                </div>
              </FormField>

              <Checkbox
                label="Política activa"
                description="Una política inactiva se guarda pero no se aplica."
                checked={editor.form.active !== false}
                onChange={(event) =>
                  setEditor((state) =>
                    state
                      ? { ...state, form: { ...state.form, active: event.target.checked } }
                      : state
                  )
                }
              />

              {formError ? <Alert variant="error">{formError}</Alert> : null}
            </div>

            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditor(null)}
                disabled={pending}
              >
                Cancelar
              </Button>
              <Button size="sm" onClick={save} disabled={pending}>
                {pending ? 'Guardando…' : 'Guardar política'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {removing ? (
        <Dialog open onOpenChange={(open) => (!open && !pending ? setRemoving(null) : undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Borrar la política</DialogTitle>
              <DialogDescription>
                {APPROVAL_POLICY_SCOPE_LABELS[removing.scope]} ·{' '}
                {policyRangeLabel(removing.minAmount, removing.maxAmount, removing.currency)}
              </DialogDescription>
            </DialogHeader>
            <Alert variant="warning">
              Las aprobaciones ya abiertas con esta política siguen su curso. Las nuevas usarán la
              siguiente política que aplique o los valores por omisión.
            </Alert>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setRemoving(null)}
                disabled={pending}
              >
                Cancelar
              </Button>
              <Button variant="danger" size="sm" onClick={remove} disabled={pending}>
                {pending ? 'Borrando…' : 'Borrar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
