'use client';

import React from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button, Checkbox, Input, Select, Textarea } from '@/components/ui/primitives';
import { BLOCK_TYPE_LABELS, type StudioBlock } from './studio-client';
import { StudioTableEditor } from './StudioTableEditor';
import { StudioImageBlockEditor } from './StudioImageBlockEditor';

interface Props {
  block: StudioBlock;
  index: number;
  total: number;
  documentId: string;
  readOnly: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onChange: (next: StudioBlock) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  onAddAfter: () => void;
}

/** One block card: header (type, selection, reorder, delete) + type-specific editor. */
export function StudioBlockEditor({
  block,
  index,
  total,
  documentId,
  readOnly,
  selected,
  onToggleSelected,
  onChange,
  onRemove,
  onMove,
  onAddAfter,
}: Props) {
  return (
    <section
      className="card card-compact"
      aria-label={`${BLOCK_TYPE_LABELS[block.type]} ${index + 1}`}
      style={selected ? { outline: '2px solid var(--unik-brand)', outlineOffset: 1 } : undefined}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '0.5rem',
        }}
      >
        <Checkbox
          label={BLOCK_TYPE_LABELS[block.type]}
          checked={selected}
          onChange={onToggleSelected}
          disabled={readOnly}
          aria-label={`Seleccionar bloque ${index + 1}`}
        />
        <span className="text-muted text-small">#{index + 1}</span>
        {!readOnly ? (
          <div className="row-actions" style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className="icon-btn"
              aria-label="Subir bloque"
              onClick={() => onMove(-1)}
              disabled={index === 0}
            >
              <ArrowUp size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Bajar bloque"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
            >
              <ArrowDown size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Agregar bloque debajo"
              onClick={onAddAfter}
            >
              <Plus size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Eliminar bloque"
              onClick={onRemove}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ) : null}
      </div>
      <BlockBody block={block} documentId={documentId} readOnly={readOnly} onChange={onChange} />
    </section>
  );
}

function BlockBody({
  block,
  documentId,
  readOnly,
  onChange,
}: {
  block: StudioBlock;
  documentId: string;
  readOnly: boolean;
  onChange: (next: StudioBlock) => void;
}) {
  switch (block.type) {
    case 'heading':
      return (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Select
            aria-label="Nivel"
            value={block.level}
            onChange={(e) => onChange({ ...block, level: Number(e.target.value) as 1 | 2 | 3 })}
            disabled={readOnly}
            style={{ maxWidth: 110 }}
          >
            <option value={1}>H1</option>
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </Select>
          <Input
            aria-label="Texto del encabezado"
            value={block.text}
            onChange={(e) => onChange({ ...block, text: e.target.value })}
            disabled={readOnly}
            maxLength={500}
            style={{ flex: '1 1 240px', fontWeight: 600 }}
          />
        </div>
      );
    case 'paragraph':
      return (
        <Textarea
          aria-label="Texto del párrafo"
          value={block.text}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
          disabled={readOnly}
          rows={Math.min(12, Math.max(3, block.text.split('\n').length + 1))}
          maxLength={20000}
        />
      );
    case 'list':
      return (
        <div>
          <Textarea
            aria-label="Elementos de la lista (uno por línea)"
            value={block.items.join('\n')}
            onChange={(e) => onChange({ ...block, items: e.target.value.split('\n') })}
            disabled={readOnly}
            rows={Math.min(12, Math.max(3, block.items.length + 1))}
            placeholder="Un elemento por línea"
          />
          <div style={{ marginTop: '0.5rem' }}>
            <Checkbox
              label="Lista numerada"
              checked={block.ordered}
              onChange={(e) => onChange({ ...block, ordered: e.target.checked })}
              disabled={readOnly}
            />
          </div>
        </div>
      );
    case 'table':
      return <StudioTableEditor block={block} readOnly={readOnly} onChange={onChange} />;
    case 'kpi':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {block.cards.map((card, i) => (
            <div
              key={i}
              style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
            >
              <Input
                aria-label={`Etiqueta del indicador ${i + 1}`}
                value={card.label}
                placeholder="Etiqueta"
                maxLength={120}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({
                    ...block,
                    cards: block.cards.map((c, j) =>
                      j === i ? { ...c, label: e.target.value } : c
                    ),
                  })
                }
                style={{ flex: '1 1 160px' }}
              />
              <Input
                aria-label={`Valor del indicador ${i + 1}`}
                value={card.value}
                placeholder="Valor (ej. $1,234.00)"
                maxLength={120}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({
                    ...block,
                    cards: block.cards.map((c, j) =>
                      j === i ? { ...c, value: e.target.value } : c
                    ),
                  })
                }
                style={{ flex: '1 1 160px', fontWeight: 600 }}
              />
              {!readOnly ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Quitar indicador ${i + 1}`}
                  disabled={block.cards.length <= 1}
                  onClick={() =>
                    onChange({ ...block, cards: block.cards.filter((_, j) => j !== i) })
                  }
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
                disabled={block.cards.length >= 12}
                onClick={() =>
                  onChange({ ...block, cards: [...block.cards, { label: '', value: '' }] })
                }
              >
                Agregar indicador
              </Button>
            </div>
          ) : null}
        </div>
      );
    case 'image':
      return (
        <StudioImageBlockEditor
          block={block}
          documentId={documentId}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'pageBreak':
      return (
        <p className="text-muted text-small">
          Salto de página: el contenido siguiente empieza en una página o diapositiva nueva.
        </p>
      );
    case 'divider':
      return (
        <hr style={{ border: 0, borderTop: '1px solid var(--unik-border)', margin: '0.25rem 0' }} />
      );
    default:
      return null;
  }
}
