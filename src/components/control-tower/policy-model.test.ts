import { describe, expect, it } from 'vitest';
import { APPROVAL_SCOPES, APPROVAL_SCOPE_LABELS } from '@/modules/operations/types';
import {
  APPROVAL_POLICY_SCOPES,
  APPROVAL_POLICY_SCOPE_HINTS,
  approvalPolicyFormSchema,
  describePolicyPreview,
  describeRequiredSignatures,
  overlappingPolicyWarnings,
  policyRangeLabel,
  policyToForm,
  scopesUsingDefaults,
  sortPolicies,
  type ApprovalPolicyRow,
} from './policy-model';

function policy(overrides: Partial<ApprovalPolicyRow> = {}): ApprovalPolicyRow {
  return {
    id: 'p1',
    scope: 'procurement',
    categoryId: null,
    categoryLabel: null,
    minAmount: '0',
    maxAmount: '50000',
    currency: 'MXN',
    requiredApprovals: 1,
    expiresAfterMinutes: null,
    approverRoleKeys: [],
    active: true,
    createdAt: '2026-09-15T12:00:00.000Z',
    updatedAt: '2026-09-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('policy-model · vocabulario', () => {
  it('usa los alcances y etiquetas del núcleo, con una pista por alcance', () => {
    expect([...APPROVAL_POLICY_SCOPES]).toEqual([...APPROVAL_SCOPES]);
    for (const scope of APPROVAL_SCOPES) {
      expect(APPROVAL_POLICY_SCOPE_HINTS[scope]).toBeTruthy();
      expect(APPROVAL_SCOPE_LABELS[scope]).toBeTruthy();
    }
  });
});

describe('policy-model · formulario', () => {
  it('acepta un rango válido', () => {
    const parsed = approvalPolicyFormSchema.parse({
      scope: 'expense',
      minAmount: '0',
      maxAmount: '2000',
      currency: 'MXN',
      requiredApprovals: 0,
    });
    expect(parsed.requiredApprovals).toBe(0);
    expect(parsed.active).toBe(true);
  });

  it('rechaza un tope menor o igual que el mínimo', () => {
    const parsed = approvalPolicyFormSchema.safeParse({
      scope: 'expense',
      minAmount: '5000',
      maxAmount: '5000',
      requiredApprovals: 1,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0].message).toContain('mayor que el mínimo');
  });

  it('acepta un tope vacío como "sin límite"', () => {
    const parsed = approvalPolicyFormSchema.parse({
      scope: 'payment',
      minAmount: '50000',
      maxAmount: '',
      requiredApprovals: 2,
    });
    expect(parsed.maxAmount).toBe('');
  });

  it('rechaza importes que no son números y firmas fuera de rango', () => {
    expect(
      approvalPolicyFormSchema.safeParse({
        scope: 'expense',
        minAmount: 'mil',
        requiredApprovals: 1,
      }).success
    ).toBe(false);
    expect(
      approvalPolicyFormSchema.safeParse({ scope: 'expense', minAmount: '0', requiredApprovals: 9 })
        .success
    ).toBe(false);
  });

  it('convierte una fila guardada en su formulario', () => {
    const form = policyToForm(policy({ categoryId: 'cat-1', currency: 'USD' }));
    expect(form).toMatchObject({ categoryId: 'cat-1', currency: 'USD', maxAmount: '50000' });
    // Una moneda desconocida cae a MXN en vez de romper el select.
    expect(policyToForm(policy({ currency: 'EUR' })).currency).toBe('MXN');
  });
});

describe('policy-model · presentación', () => {
  it('describe el rango como [mínimo, tope)', () => {
    expect(policyRangeLabel('0', '50000', 'MXN')).toBe('De $0 a $50,000');
    expect(policyRangeLabel('50000', null, 'MXN')).toBe('Desde $50,000');
  });

  it('describe las firmas necesarias', () => {
    expect(describeRequiredSignatures(0)).toContain('sin firma');
    expect(describeRequiredSignatures(1)).toBe('Una firma');
    expect(describeRequiredSignatures(3)).toBe('3 firmas distintas');
  });

  it('ordena por alcance, moneda e importe', () => {
    const rows = [
      policy({ id: 'b', scope: 'payment', minAmount: '100' }),
      policy({ id: 'a', scope: 'procurement', minAmount: '50000', maxAmount: null }),
      policy({ id: 'c', scope: 'procurement', minAmount: '0' }),
    ];
    expect(sortPolicies(rows).map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('avisa cuando dos políticas activas se encima', () => {
    const warnings = overlappingPolicyWarnings([
      policy({ id: 'a', minAmount: '0', maxAmount: '50000' }),
      policy({ id: 'b', minAmount: '10000', maxAmount: null }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('se encima');
  });

  it('no avisa por rangos contiguos ni por políticas inactivas', () => {
    expect(
      overlappingPolicyWarnings([
        policy({ id: 'a', minAmount: '0', maxAmount: '50000' }),
        policy({ id: 'b', minAmount: '50000', maxAmount: null }),
      ])
    ).toEqual([]);
    expect(
      overlappingPolicyWarnings([
        policy({ id: 'a', minAmount: '0', maxAmount: '50000' }),
        policy({ id: 'b', minAmount: '0', maxAmount: null, active: false }),
      ])
    ).toEqual([]);
  });

  it('no avisa cuando cambian la moneda o la categoría', () => {
    expect(
      overlappingPolicyWarnings([
        policy({ id: 'a', currency: 'MXN' }),
        policy({ id: 'b', currency: 'USD' }),
      ])
    ).toEqual([]);
    expect(
      overlappingPolicyWarnings([
        policy({ id: 'a', categoryId: null }),
        policy({ id: 'b', categoryId: 'cat-1' }),
      ])
    ).toEqual([]);
  });

  it('nombra los alcances que siguen con los valores por omisión', () => {
    const scopes = scopesUsingDefaults([policy({ scope: 'procurement' })]);
    expect(scopes).not.toContain('procurement');
    expect(scopes).toContain('expense');
    expect(scopesUsingDefaults([policy({ scope: 'procurement', active: false })])).toContain(
      'procurement'
    );
  });
});

describe('policy-model · vista previa', () => {
  it('dice que se aprobaría solo cuando no pide firmas', () => {
    const { summary, warning } = describePolicyPreview({
      requiredApprovals: 0,
      approvers: 0,
      fromDefaults: true,
    });
    expect(summary).toContain('sin pedir firma');
    expect(warning).toBeNull();
  });

  it('avisa cuando no hay suficientes personas elegibles', () => {
    const { warning } = describePolicyPreview({
      requiredApprovals: 2,
      approvers: 1,
      fromDefaults: false,
    });
    expect(warning).toContain('no_approvers');
  });

  it('no avisa cuando alcanzan las personas', () => {
    const { summary, warning } = describePolicyPreview({
      requiredApprovals: 2,
      approvers: 3,
      fromDefaults: false,
    });
    expect(summary).toContain('3 personas elegibles');
    expect(warning).toBeNull();
  });
});
