'use client';

import React, { useState } from 'react';
import { Bookmark, Check, ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { useSavedTemplates, type SavedTemplate } from '@/lib/hooks/use-saved-templates';

export interface TemplatePickerProps {
  /** Currently selected Content SID. */
  value: string;
  /** Called when the user picks a saved template or types a SID. */
  onChange: (contentSid: string, body?: string) => void;
  /** Optional body text — when a saved template has a body, it fills this. */
  onBodyChange?: (body: string) => void;
  /** Current body text (to pre-fill the save dialog). */
  currentBody?: string;
  /** Disable the entire picker. */
  disabled?: boolean;
}

/**
 * WhatsApp template (Content SID) picker with saved templates.
 *
 * - Dropdown of previously saved templates (persisted in localStorage).
 * - "Save current" button stores the current SID + label + optional body.
 * - Delete saved templates with a trash icon.
 * - Falls back to a plain text input for the SID when no template is selected.
 */
export function TemplatePicker({
  value,
  onChange,
  onBodyChange,
  currentBody,
  disabled,
}: TemplatePickerProps) {
  const { templates, addTemplate, removeTemplate } = useSavedTemplates();
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveLabel, setSaveLabel] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const selected = templates.find((t) => t.contentSid === value);

  function handleSelect(template: SavedTemplate) {
    onChange(template.contentSid, template.body);
    if (onBodyChange && template.body) onBodyChange(template.body);
    setDropdownOpen(false);
  }

  function handleSave() {
    if (!value.trim()) return;
    addTemplate(saveLabel || value, value, currentBody);
    setSaveLabel('');
    setShowSaveDialog(false);
  }

  return (
    <div className="template-picker">
      {/* Dropdown + input row */}
      <div className="template-picker-row">
        <input
          type="text"
          className="template-picker-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="HX…"
          disabled={disabled}
          aria-label="Content SID de plantilla aprobada"
        />
        {templates.length > 0 && (
          <button
            type="button"
            className="template-picker-dropdown-btn"
            onClick={() => setDropdownOpen((v) => !v)}
            disabled={disabled}
            aria-label="Ver plantillas guardadas"
            aria-expanded={dropdownOpen}
          >
            <ChevronDown size={16} />
          </button>
        )}
        <button
          type="button"
          className="template-picker-save-btn"
          onClick={() => setShowSaveDialog(true)}
          disabled={disabled || !value.trim()}
          aria-label="Guardar plantilla actual"
          title="Guardar plantilla actual"
        >
          <Bookmark size={16} />
        </button>
      </div>

      {/* Selected indicator */}
      {selected && (
        <div className="template-picker-selected">
          <Check size={14} />
          <span>{selected.label}</span>
        </div>
      )}

      {/* Dropdown of saved templates */}
      {dropdownOpen && templates.length > 0 && (
        <>
          <div className="template-picker-backdrop" onClick={() => setDropdownOpen(false)} aria-hidden="true" />
          <div className="template-picker-dropdown" role="listbox">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`template-picker-item ${t.contentSid === value ? 'active' : ''}`}
                onClick={() => handleSelect(t)}
                role="option"
                aria-selected={t.contentSid === value}
              >
                <div className="template-picker-item-info">
                  <span className="template-picker-item-label">{t.label}</span>
                  <span className="template-picker-item-sid">{t.contentSid}</span>
                  {t.body && <span className="template-picker-item-body">{t.body.slice(0, 60)}{t.body.length > 60 ? '…' : ''}</span>}
                </div>
                <button
                  type="button"
                  className="template-picker-item-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTemplate(t.id);
                  }}
                  aria-label={`Eliminar ${t.label}`}
                  title="Eliminar"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="template-picker-save-dialog" role="dialog" aria-label="Guardar plantilla">
          <div className="template-picker-save-row">
            <input
              type="text"
              className="template-picker-save-input"
              value={saveLabel}
              onChange={(e) => setSaveLabel(e.target.value)}
              placeholder="Nombre descriptivo (ej. Bienvenida nuevo cliente)"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') setShowSaveDialog(false);
              }}
            />
            <button type="button" className="template-picker-save-confirm" onClick={handleSave}>
              <Plus size={16} /> Guardar
            </button>
            <button
              type="button"
              className="template-picker-save-cancel"
              onClick={() => setShowSaveDialog(false)}
              aria-label="Cancelar"
            >
              <X size={16} />
            </button>
          </div>
          <p className="template-picker-save-hint">
            SID: <code>{value}</code>
            {currentBody ? ' · Se guardará el mensaje actual' : ''}
          </p>
        </div>
      )}
    </div>
  );
}
