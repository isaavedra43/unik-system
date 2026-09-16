import { describe, expect, it } from 'vitest';
import { MASK_RULES } from '@/modules/control-tower/graph-mask';
import { markSensitive, type AreaRowField } from './area-work-row';
import { maskRowFields, maskedRowFieldKinds, rowFieldsWereMasked } from './row-mask';

/**
 * El detalle de una fila del centro de trabajo mostraba SIEMPRE el importe y los
 * datos de contacto, aunque la misma persona los viera enmascarados en el grafo
 * de la Torre de Control. Estas pruebas fijan que ahora se aplica la MISMA tabla
 * (`MASK_RULES`, no una copia) y que lo que se oculta es el DATO, nunca el
 * nombre que identifica la fila.
 */

const viewer = (permissionKeys: string[], isSuperAdmin = false) => ({
  permissionKeys,
  isSuperAdmin,
});

function fields(): AreaRowField[] {
  return [
    { label: 'Folio', value: 'OC-0001', hint: null },
    { label: 'Cliente', value: 'Aceros del Norte', hint: null },
    markSensitive({ label: 'Importe', value: '$120,000', hint: 'IVA incluido' }, 'amount')!,
    markSensitive({ label: 'Contacto', value: 'Luis · 81 1234 5678', hint: null }, 'contact')!,
  ];
}

describe('enmascarado del detalle de una fila', () => {
  it('usa la tabla de la Torre de Control, no una segunda lista', () => {
    const amount = MASK_RULES.find((rule) => rule.field === 'amount');
    const contact = MASK_RULES.find((rule) => rule.field === 'contact');
    expect(amount?.permissions).toStrictEqual(['finance.view']);
    expect(contact?.permissions).toStrictEqual(['customers.view']);
    expect(maskedRowFieldKinds(viewer(['logistics.view']))).toStrictEqual(['amount', 'contact']);
    expect(maskedRowFieldKinds(viewer(['finance.view']))).toStrictEqual(['contact']);
    expect(maskedRowFieldKinds(viewer(['finance.view', 'customers.view']))).toStrictEqual([]);
    // `operations.admin` abre la Torre y NO levanta las máscaras; super_admin sí.
    expect(maskedRowFieldKinds(viewer(['operations.admin']))).toStrictEqual(['amount', 'contact']);
    expect(maskedRowFieldKinds(viewer([], true))).toStrictEqual([]);
  });

  it('sustituye el dato por su explicación en vez de borrar el renglón', () => {
    const masked = maskRowFields(fields(), viewer(['logistics.view']));
    expect(masked).toHaveLength(4);
    expect(masked.map((entry) => entry.label)).toStrictEqual([
      'Folio',
      'Cliente',
      'Importe',
      'Contacto',
    ]);
    expect(masked[2].value).toBe('Importe oculto (requiere Contabilidad)');
    expect(masked[2].hint).toBeNull();
    expect(masked[3].value).toBe('Datos de contacto ocultos (requiere Clientes)');
    // El nombre que identifica la fila sobrevive, igual que el `label` del nodo.
    expect(masked[1].value).toBe('Aceros del Norte');
    expect(masked[0].value).toBe('OC-0001');
  });

  it('quien tiene el permiso ve el dato intacto', () => {
    const seen = maskRowFields(fields(), viewer(['finance.view', 'customers.view']));
    expect(seen[2]).toStrictEqual({
      label: 'Importe',
      value: '$120,000',
      hint: 'IVA incluido',
      sensitive: 'amount',
    });
    expect(seen[3].value).toBe('Luis · 81 1234 5678');
    expect(rowFieldsWereMasked(fields(), viewer(['finance.view', 'customers.view']))).toBe(false);
  });

  it('oculta sólo la clase que falta', () => {
    const masked = maskRowFields(fields(), viewer(['finance.view']));
    expect(masked[2].value).toBe('$120,000');
    expect(masked[3].value).toBe('Datos de contacto ocultos (requiere Clientes)');
    expect(rowFieldsWereMasked(fields(), viewer(['finance.view']))).toBe(true);
  });

  it('un campo sin marca nunca se toca y `markSensitive` respeta el nulo', () => {
    const plain = [{ label: 'Estado', value: 'Abierta', hint: null }];
    expect(maskRowFields(plain, viewer([]))).toStrictEqual(plain);
    expect(markSensitive(null, 'amount')).toBeNull();
  });
});
