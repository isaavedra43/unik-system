'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui/primitives';
import {
  parseStudioNumber,
  renderCellText,
  type StudioColumnFormat,
} from '@/modules/studio/studio-format';
import { COLUMN_FORMAT_LABELS, columnKeyFor, type TableBlock } from './studio-client';

interface Props {
  block: TableBlock;
  readOnly: boolean;
  onChange: (next: TableBlock) => void;
}

const FORMATS = Object.keys(COLUMN_FORMAT_LABELS) as StudioColumnFormat[];
const MAX_EDITABLE_ROWS = 300;

/**
 * Cell-level table editor. Numeric columns store real numbers when the typed
 * text parses (so exports write numbers, not strings); anything else stays text.
 */
export function StudioTableEditor({ block, readOnly, onChange }: Props) {
  function setColumn(i: number, patch: Partial<TableBlock['columns'][number]>) {
    onChange({
      ...block,
      columns: block.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  }
  function addColumn() {
    const key = columnKeyFor(block, `columna ${block.columns.length + 1}`);
    onChange({
      ...block,
      columns: [...block.columns, { key, header: `Columna ${block.columns.length + 1}` }],
      rows: block.rows.map((r) => ({ ...r, [key]: null })),
    });
  }
  function removeColumn(i: number) {
    const key = block.columns[i].key;
    onChange({
      ...block,
      columns: block.columns.filter((_, j) => j !== i),
      rows: block.rows.map((r) => {
        const next = { ...r };
        delete next[key];
        return next;
      }),
    });
  }
  function setCell(rowIndex: number, key: string, text: string, format?: StudioColumnFormat) {
    const numeric = format === 'number' || format === 'currency' || format === 'percentage';
    const parsed = numeric ? parseStudioNumber(text) : null;
    const value = text === '' ? null : parsed !== null && numeric ? parsed : text;
    onChange({
      ...block,
      rows: block.rows.map((r, i) => (i === rowIndex ? { ...r, [key]: value } : r)),
    });
  }
  function addRow() {
    const empty: Record<string, null> = {};
    for (const c of block.columns) empty[c.key] = null;
    onChange({ ...block, rows: [...block.rows, empty] });
  }
  function removeRow(i: number) {
    onChange({ ...block, rows: block.rows.filter((_, j) => j !== i) });
  }

  const tooManyRows = block.rows.length > MAX_EDITABLE_ROWS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <Input
        aria-label="Título de la tabla"
        placeholder="Título de la tabla (opcional)"
        value={block.title ?? ''}
        maxLength={200}
        disabled={readOnly}
        onChange={(e) => onChange({ ...block, title: e.target.value })}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        <span className="text-muted text-small">Columnas</span>
        {block.columns.map((col, i) => (
          <div
            key={col.key}
            style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
          >
            <Input
              aria-label={`Encabezado de la columna ${i + 1}`}
              value={col.header}
              maxLength={200}
              disabled={readOnly}
              onChange={(e) => setColumn(i, { header: e.target.value })}
              style={{ flex: '1 1 160px' }}
            />
            <Select
              aria-label={`Formato de la columna ${i + 1}`}
              value={col.format ?? 'text'}
              disabled={readOnly}
              onChange={(e) => setColumn(i, { format: e.target.value as StudioColumnFormat })}
              style={{ maxWidth: 150 }}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {COLUMN_FORMAT_LABELS[f]}
                </option>
              ))}
            </Select>
            {!readOnly ? (
              <button
                type="button"
                className="icon-btn"
                aria-label={`Quitar columna ${col.header || i + 1}`}
                disabled={block.columns.length <= 1}
                onClick={() => removeColumn(i)}
              >
                <Trash2 size={16} />
              </button>
            ) : null}
          </div>
        ))}
        {!readOnly ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={14} />}
              disabled={block.columns.length >= 50}
              onClick={addColumn}
            >
              Agregar columna
            </Button>
          </div>
        ) : null}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              {block.columns.map((c) => (
                <th key={c.key}>{c.header || c.key}</th>
              ))}
              {!readOnly ? <th aria-label="Acciones" /> : null}
            </tr>
          </thead>
          <tbody>
            {block.rows.slice(0, MAX_EDITABLE_ROWS).map((row, r) => (
              <tr key={r}>
                <td className="text-muted">{r + 1}</td>
                {block.columns.map((c) => {
                  const raw = row[c.key];
                  const display =
                    raw === null || raw === undefined
                      ? ''
                      : typeof raw === 'number'
                        ? String(raw)
                        : String(raw);
                  return (
                    <td key={c.key}>
                      {readOnly ? (
                        renderCellText(raw, c.format)
                      ) : (
                        <input
                          className="input"
                          aria-label={`${c.header || c.key}, fila ${r + 1}`}
                          defaultValue={display}
                          key={`${c.key}-${r}-${display}`}
                          onBlur={(e) => {
                            if (e.target.value !== display)
                              setCell(r, c.key, e.target.value, c.format);
                          }}
                          style={{
                            minWidth: 100,
                            textAlign:
                              c.format && c.format !== 'text' && c.format !== 'date'
                                ? 'right'
                                : 'left',
                          }}
                        />
                      )}
                    </td>
                  );
                })}
                {!readOnly ? (
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Eliminar fila ${r + 1}`}
                      onClick={() => removeRow(r)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tooManyRows ? (
        <p className="text-muted text-small">
          Se muestran las primeras {MAX_EDITABLE_ROWS} filas de {block.rows.length}; el resto se
          conserva y se exporta íntegro.
        </p>
      ) : null}
      {!readOnly ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={14} />}
            disabled={block.rows.length >= 5000}
            onClick={addRow}
          >
            Agregar fila
          </Button>
        </div>
      ) : null}
    </div>
  );
}
