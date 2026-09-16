import { describe, expect, it } from 'vitest';
import { agree, allEntitiesLabel, definiteArticle, definiteArticlePlural } from './entity-labels';

describe('entity-labels', () => {
  it('mantiene el masculino de las tablas que ya existían', () => {
    expect(allEntitiesLabel('Órdenes de venta', 'm')).toBe('Todos los órdenes de venta');
    expect(definiteArticle('m')).toBe('el');
    expect(definiteArticlePlural('m')).toBe('los');
    expect(agree('seguido', 'm')).toBe('seguido');
    expect(agree('seguido', 'm', { plural: true })).toBe('seguidos');
  });

  it('concuerda en femenino («Todos los excepciones» era el defecto)', () => {
    expect(allEntitiesLabel('Excepciones', 'f')).toBe('Todas las excepciones');
    expect(definiteArticle('f')).toBe('la');
    expect(definiteArticlePlural('f')).toBe('las');
    expect(agree('seguido', 'f')).toBe('seguida');
    expect(agree('seguido', 'f', { plural: true })).toBe('seguidas');
    expect(agree('actualizado', 'f', { plural: true })).toBe('actualizadas');
  });

  it('deja intacto un participio que no termina en «o»', () => {
    expect(agree('pendiente', 'f')).toBe('pendiente');
    expect(agree('pendiente', 'm', { plural: true })).toBe('pendientes');
  });
});
