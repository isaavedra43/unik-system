import { describe, expect, it } from 'vitest';
import { isSafeHref, sanitizeGenUiSpec } from './validate';

const report = {
  root: 'card',
  elements: {
    card: {
      type: 'Card',
      props: { title: 'Ventas de ayer', icon: 'chart' },
      children: ['kpis', 'filter', 'table', 'btn'],
    },
    kpis: { type: 'Grid', props: { columns: 3 }, children: ['m1'] },
    m1: {
      type: 'Metric',
      props: { label: 'Total', value: { $state: '/total' }, format: 'money', trend: 'up' },
    },
    filter: {
      type: 'Select',
      props: {
        label: 'Sucursal',
        value: { $bindState: '/branch' },
        options: [
          { value: '', label: 'Todas' },
          { value: 'Norte', label: 'Norte' },
        ],
      },
    },
    table: {
      type: 'Table',
      props: {
        columns: [
          { key: 'folio', label: 'Folio' },
          { key: 'total', label: 'Total', format: 'money', align: 'right' },
        ],
        rows: { $state: '/rows' },
        filterKey: 'branch',
        filterValue: { $state: '/branch' },
        searchable: true,
      },
    },
    btn: {
      type: 'Button',
      props: { label: 'Exportar a Excel', icon: 'download' },
      on: { press: { action: 'ask', params: { text: 'Exporta esta tabla a Excel' } } },
    },
  },
  state: { total: 59468, branch: '', rows: [{ folio: 'SO-1', total: 100, branch: 'Norte' }] },
};

describe('sanitizeGenUiSpec', () => {
  it('keeps a well-formed report card intact', () => {
    const { spec, issues } = sanitizeGenUiSpec(report);
    expect(issues).toEqual([]);
    expect(Object.keys(spec!.elements)).toHaveLength(6);
    expect(spec!.elements.table.props.rows).toEqual({ $state: '/rows' });
    expect(spec!.elements.btn.on).toEqual({
      press: { action: 'ask', params: { text: 'Exporta esta tabla a Excel' } },
    });
    expect(spec!.state).toEqual(report.state);
  });

  it('drops unknown components, props and actions, reporting each one', () => {
    const { spec, issues } = sanitizeGenUiSpec({
      root: 'a',
      elements: {
        a: { type: 'Stack', props: { style: 'color:red', gap: 'md' }, children: ['b', 'c', 'd'] },
        b: { type: 'Script', props: { code: 'alert(1)' } },
        c: {
          type: 'Button',
          props: { label: 'Borrar todo' },
          on: { press: { action: 'deleteDatabase', params: {} } },
        },
        d: { type: 'Text', props: { text: 'hola', onClick: 'x' } },
      },
    });
    expect(spec!.elements.b).toBeUndefined();
    expect(spec!.elements.a.props).toEqual({ gap: 'md' });
    expect(spec!.elements.a.children).toEqual(['c', 'd']);
    expect(spec!.elements.c.on).toBeUndefined();
    expect(spec!.elements.d.props).toEqual({ text: 'hola' });
    expect(issues.join(' ')).toMatch(/Script/);
    expect(issues.join(' ')).toMatch(/deleteDatabase/);
    expect(issues.join(' ')).toMatch(/style/);
  });

  it('rejects $computed, unsafe links and malformed pointers', () => {
    const { spec } = sanitizeGenUiSpec({
      root: 'a',
      elements: {
        a: { type: 'Stack', props: {}, children: ['t', 'img', 'b', 'f'] },
        t: { type: 'Text', props: { text: { $computed: 'steal', args: {} } } },
        img: { type: 'Image', props: { src: 'javascript:alert(1)', alt: 'x' } },
        b: {
          type: 'Button',
          props: { label: 'Abrir' },
          on: { press: { action: 'openUrl', params: { url: 'javascript:alert(1)' } } },
        },
        f: {
          type: 'Input',
          props: { label: 'x', value: { $bindState: 'no-slash/../x' } },
        },
      },
    });
    // Text lost its only required prop → element dropped.
    expect(spec!.elements.t).toBeUndefined();
    expect(spec!.elements.img).toBeUndefined();
    expect(spec!.elements.b.on).toBeUndefined();
    expect(spec!.elements.f.props.value).toBeUndefined();
  });

  it('allows https and in-app links only', () => {
    expect(isSafeHref('https://unik.mx/a')).toBe(true);
    expect(isSafeHref('/app/sales/orders')).toBe(true);
    expect(isSafeHref('http://insecure.example')).toBe(false);
    expect(isSafeHref('//evil.example')).toBe(false);
    expect(isSafeHref('data:text/html,<script>')).toBe(false);
  });

  it('breaks cycles, drops unreachable elements and leaf children', () => {
    const { spec } = sanitizeGenUiSpec({
      root: 'a',
      elements: {
        a: { type: 'Card', props: {}, children: ['b'] },
        b: { type: 'Card', props: {}, children: ['a', 'c'] },
        c: { type: 'Text', props: { text: 'x' }, children: ['a'] },
        orphan: { type: 'Text', props: { text: 'nadie me usa' } },
      },
    });
    expect(Object.keys(spec!.elements).sort()).toEqual(['a', 'b', 'c']);
    expect(spec!.elements.b.children).toEqual(['c']);
    expect(spec!.elements.c.children).toEqual([]);
  });

  it('validates visibility, repeat and state-only built-in actions', () => {
    const { spec, issues } = sanitizeGenUiSpec({
      root: 'tabs',
      elements: {
        tabs: {
          type: 'Tabs',
          props: {
            tabs: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
            value: { $bindState: '/tab' },
          },
          children: ['pa', 'pb'],
        },
        pa: {
          type: 'Stack',
          props: {},
          visible: { $state: '/tab', eq: 'a' },
          repeat: { statePath: '/items', key: 'id' },
          children: ['item'],
        },
        item: { type: 'Text', props: { text: { $item: 'name' } } },
        pb: {
          type: 'Button',
          props: { label: 'Ir a A' },
          visible: { $state: '/tab', eq: 'b', hack: true },
          on: { press: { action: 'setState', params: { statePath: '/tab', value: 'a' } } },
        },
      },
      state: { tab: 'a', items: [{ id: 1, name: 'x' }] },
    });
    expect(spec!.elements.pa.visible).toEqual({ $state: '/tab', eq: 'a' });
    expect(spec!.elements.pa.repeat).toEqual({ statePath: '/items', key: 'id' });
    expect(spec!.elements.pb.visible).toBeUndefined();
    expect(spec!.elements.pb.on).toEqual({
      press: { action: 'setState', params: { statePath: '/tab', value: 'a' } },
    });
    expect(issues.join(' ')).toMatch(/visible/);
  });

  it('refuses specs without a valid root and oversized state', () => {
    expect(sanitizeGenUiSpec({ root: 'x', elements: {} }).spec).toBeNull();
    expect(sanitizeGenUiSpec('nope').spec).toBeNull();
    const big = sanitizeGenUiSpec({
      root: 'a',
      elements: { a: { type: 'Text', props: { text: 'x' } } },
      state: { blob: 'x'.repeat(250_000) },
    });
    expect(big.spec?.state).toBeUndefined();
  });
});
