'use client';

import '@/styles/operations/inventario.css';
import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Save, Trash2 } from 'lucide-react';
import {
  EMPTY_FORM_STATE,
  saveProfileAction,
  type ProfilePatchInput,
} from '@/app/app/areas/inventario/actions';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
} from '@/components/ui/primitives';
import type { ProfilePageData } from '@/modules/areas/inventario/inventory-area-queries';
import {
  TRACKING_POLICIES,
  TRACKING_POLICY_LABELS,
  SUGGESTED_VARIANT_AXES,
} from '@/modules/inventory/inventory-types';
import { ALLOCATION_SOURCES, ALLOCATION_SOURCE_LABELS } from '@/modules/operations/types';
import {
  MAX_CONVERSIONS,
  confidenceLabel,
  confidenceTone,
  formatQty,
  movementKindLabel,
  validateProfileForm,
  type ProfileFormValues,
} from './inventario-model';

/**
 * Perfil de inventario de un artículo (plan 7.6 "perfiles"): unidad base,
 * conversiones, tolerancia, variables, política de rastreo y fuente por
 * defecto.
 *
 * The form validates with the same rules the module applies before sending
 * anything (`validateProfileForm`), and the change travels as the command
 * `profile.update` with the optimistic version of the profile, so two people
 * editing at once never overwrite each other in silence.
 */

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

export interface ProfileFormProps {
  data: ProfilePageData;
  /** The person holds `inventory.manage`. */
  canManage: boolean;
}

function initialValues(data: ProfilePageData): ProfileFormValues {
  const profile = data.profile;
  return {
    baseUnit: profile?.baseUnit ?? '',
    tolerancePct: profile ? String(Number(profile.tolerancePct)) : '0',
    trackingPolicy: profile?.trackingPolicy ?? 'none',
    defaultSource: profile?.defaultSource ?? 'stock',
    isBulk: profile?.isBulk ?? false,
    variantAxes: (profile?.variantAxes ?? []).join(', '),
    conversions: (profile?.conversions ?? []).map((entry) => ({
      unit: entry.unit,
      factor: String(Number(entry.factor)),
    })),
    weightKgPerBaseUnit: profile?.weightKgPerBaseUnit
      ? String(Number(profile.weightKgPerBaseUnit))
      : '',
    areaM2PerBaseUnit: profile?.areaM2PerBaseUnit ? String(Number(profile.areaM2PerBaseUnit)) : '',
  };
}

export function ProfileForm({ data, canManage }: ProfileFormProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(saveProfileAction, EMPTY_FORM_STATE);
  const [values, setValues] = useState<ProfileFormValues>(() => initialValues(data));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (state.success) {
      setErrors({});
      router.refresh();
    }
  }, [state.success, router]);

  const profile = data.profile;
  const set = <K extends keyof ProfileFormValues>(key: K, value: ProfileFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!profile) return;
    const checked = validateProfileForm(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const input: ProfilePatchInput = {
      profileId: profile.id,
      zohoItemId: data.zohoItemId,
      version: profile.version,
      ...checked.patch,
    };
    formAction(input);
  }

  return (
    <div className="area-space">
      <section className="inv-card" aria-labelledby="inv-profile-summary">
        <h3 id="inv-profile-summary" className="inv-card-title">
          <span>{data.product?.name ?? data.product?.sku ?? data.zohoItemId}</span>
          {profile ? (
            <Badge variant={BADGE_BY_TONE[confidenceTone(profile.confidence)]}>
              {confidenceLabel(profile.confidence)}
            </Badge>
          ) : null}
        </h3>
        <dl className="area-drawer-fields">
          <div className="area-drawer-field">
            <dt>SKU</dt>
            <dd>{data.product?.sku ?? '—'}</dd>
          </div>
          <div className="area-drawer-field">
            <dt>Conocido</dt>
            <dd>{formatQty(data.totals.known, profile?.baseUnit)}</dd>
          </div>
          <div className="area-drawer-field">
            <dt>Disponible</dt>
            <dd>{formatQty(data.totals.available, profile?.baseUnit)}</dd>
          </div>
          <div className="area-drawer-field">
            <dt>Reservado</dt>
            <dd>{formatQty(data.totals.reserved, profile?.baseUnit)}</dd>
          </div>
          <div className="area-drawer-field">
            <dt>Filas de existencia</dt>
            <dd>{data.totals.rows}</dd>
          </div>
          <div className="area-drawer-field">
            <dt>Zoho (informativo)</dt>
            <dd className="inv-zoho">
              {data.product?.availableStock === null || data.product?.availableStock === undefined
                ? '—'
                : formatQty(data.product.availableStock)}
            </dd>
          </div>
          {profile?.consecutiveGoodCounts ? (
            <div className="area-drawer-field">
              <dt>Conteos buenos seguidos</dt>
              <dd>{profile.consecutiveGoodCounts}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {!profile ? (
        <Alert variant="info">
          Este artículo todavía no tiene perfil de inventario. Se crea solo con su primer conteo o
          movimiento; a partir de ahí se pueden configurar aquí su unidad base, sus conversiones y
          su tolerancia.
        </Alert>
      ) : (
        <form className="inv-form" onSubmit={onSubmit}>
          {state.error ? <Alert variant="error">{state.error}</Alert> : null}
          {state.success && state.message ? <Alert variant="success">{state.message}</Alert> : null}
          {!canManage ? (
            <Alert variant="info">
              Puedes consultar el perfil; para cambiarlo necesitas el permiso de gestionar
              inventario.
            </Alert>
          ) : null}

          <div className="inv-form-grid">
            <FormField
              label="Unidad base"
              htmlFor="inv-profile-base-unit"
              error={errors.baseUnit}
              help={
                data.baseUnitLocked
                  ? 'No se puede cambiar: el artículo ya tiene movimientos, reservas o partidas abiertas.'
                  : 'En esta unidad se guardan todas las cantidades (pz, m2, kg…).'
              }
            >
              <Input
                id="inv-profile-base-unit"
                value={values.baseUnit}
                onChange={(event) => set('baseUnit', event.target.value)}
                disabled={!canManage || data.baseUnitLocked}
                error={errors.baseUnit}
                maxLength={30}
              />
            </FormField>

            <FormField
              label="Tolerancia de conteo (%)"
              htmlFor="inv-profile-tolerance"
              error={errors.tolerancePct}
              help="Diferencia que se acepta sin abrir una disputa. 0 = exacto."
            >
              <Input
                id="inv-profile-tolerance"
                value={values.tolerancePct}
                onChange={(event) => set('tolerancePct', event.target.value)}
                inputMode="decimal"
                disabled={!canManage}
                error={errors.tolerancePct}
              />
            </FormField>

            <FormField
              label="Política de rastreo"
              htmlFor="inv-profile-tracking"
              help="Rollo, placa o contenedor guardan una fila por unidad física con su etiqueta."
            >
              <Select
                id="inv-profile-tracking"
                value={values.trackingPolicy}
                onChange={(event) => set('trackingPolicy', event.target.value)}
                disabled={!canManage}
              >
                {TRACKING_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {TRACKING_POLICY_LABELS[policy]}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Fuente por defecto"
              htmlFor="inv-profile-source"
              help="De dónde sale este artículo cuando Ventas lo promete."
            >
              <Select
                id="inv-profile-source"
                value={values.defaultSource}
                onChange={(event) => set('defaultSource', event.target.value)}
                disabled={!canManage}
              >
                {ALLOCATION_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {ALLOCATION_SOURCE_LABELS[source]}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Variables del artículo"
              htmlFor="inv-profile-axes"
              error={errors.variantAxes}
              help={`Separadas por comas. Sugeridas: ${SUGGESTED_VARIANT_AXES.join(', ')}.`}
            >
              <Input
                id="inv-profile-axes"
                value={values.variantAxes}
                onChange={(event) => set('variantAxes', event.target.value)}
                disabled={!canManage}
                error={errors.variantAxes}
              />
            </FormField>

            <FormField
              label="Peso por unidad base (kg)"
              htmlFor="inv-profile-weight"
              error={errors.weightKgPerBaseUnit}
              help="Opcional. Se usa para la capacidad de carga en logística."
            >
              <Input
                id="inv-profile-weight"
                value={values.weightKgPerBaseUnit}
                onChange={(event) => set('weightKgPerBaseUnit', event.target.value)}
                inputMode="decimal"
                disabled={!canManage}
                error={errors.weightKgPerBaseUnit}
              />
            </FormField>

            <FormField
              label="Superficie por unidad base (m²)"
              htmlFor="inv-profile-area"
              error={errors.areaM2PerBaseUnit}
              help="Opcional. Se usa para la capacidad de carga en logística."
            >
              <Input
                id="inv-profile-area"
                value={values.areaM2PerBaseUnit}
                onChange={(event) => set('areaM2PerBaseUnit', event.target.value)}
                inputMode="decimal"
                disabled={!canManage}
                error={errors.areaM2PerBaseUnit}
              />
            </FormField>
          </div>

          <Checkbox
            label="Es material a granel"
            description="Admite fracciones y se cuenta por peso o volumen."
            checked={values.isBulk}
            onChange={(event) => set('isBulk', event.target.checked)}
            disabled={!canManage}
          />

          <section aria-labelledby="inv-profile-conversions">
            <h3 id="inv-profile-conversions" className="area-drawer-section-title">
              Conversiones de unidad
            </h3>
            <p className="inv-card-hint">
              Cuántas unidades base entran en cada unidad de compra o venta. Ejemplo: 1 caja = 12
              pz.
            </p>
            {errors.conversions ? <Alert variant="error">{errors.conversions}</Alert> : null}
            {values.conversions.map((conversion, index) => (
              <div className="inv-conversion-row" key={`conversion-${index}`}>
                <FormField
                  label="Unidad"
                  htmlFor={`inv-conversion-unit-${index}`}
                  error={errors[`conversions.${index}.unit`]}
                >
                  <Input
                    id={`inv-conversion-unit-${index}`}
                    value={conversion.unit}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        conversions: current.conversions.map((entry, position) =>
                          position === index ? { ...entry, unit: event.target.value } : entry
                        ),
                      }))
                    }
                    disabled={!canManage}
                    error={errors[`conversions.${index}.unit`]}
                    maxLength={30}
                  />
                </FormField>
                <FormField
                  label="Unidades base"
                  htmlFor={`inv-conversion-factor-${index}`}
                  error={errors[`conversions.${index}.factor`]}
                >
                  <Input
                    id={`inv-conversion-factor-${index}`}
                    value={conversion.factor}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        conversions: current.conversions.map((entry, position) =>
                          position === index ? { ...entry, factor: event.target.value } : entry
                        ),
                      }))
                    }
                    inputMode="decimal"
                    disabled={!canManage}
                    error={errors[`conversions.${index}.factor`]}
                  />
                </FormField>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Quitar la conversión ${conversion.unit || index + 1}`}
                  disabled={!canManage}
                  onClick={() =>
                    setValues((current) => ({
                      ...current,
                      conversions: current.conversions.filter((_, position) => position !== index),
                    }))
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canManage || values.conversions.length >= MAX_CONVERSIONS}
              onClick={() =>
                setValues((current) => ({
                  ...current,
                  conversions: [...current.conversions, { unit: '', factor: '' }],
                }))
              }
            >
              <Plus size={14} aria-hidden="true" />
              Agregar conversión
            </Button>
          </section>

          <div className="inv-form-actions">
            <Button type="submit" size="sm" isLoading={pending} disabled={!canManage}>
              <Save size={14} aria-hidden="true" />
              Guardar perfil
            </Button>
            <span className="inv-card-hint">
              Versión {profile.version}. Si alguien más lo cambió mientras editabas, te avisamos sin
              sobrescribir.
            </span>
          </div>
        </form>
      )}

      <section className="inv-card" aria-labelledby="inv-profile-movements">
        <h3 id="inv-profile-movements" className="inv-card-title">
          Últimos movimientos
        </h3>
        {data.movements.length === 0 ? (
          <p className="inv-card-hint">Este artículo todavía no tiene movimientos registrados.</p>
        ) : (
          <ul className="inv-list">
            {data.movements.map((movement) => (
              <li key={movement.id} className="inv-list-item">
                <span className="inv-list-main">
                  <span>{movementKindLabel(movement.kind)}</span>
                  <span className="inv-list-sub">
                    {[movement.warehouseName, movement.locationCode, movement.containerKey]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="inv-qty">
                  {formatQty(movement.quantity, profile?.baseUnit ?? movement.originalUnit)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
