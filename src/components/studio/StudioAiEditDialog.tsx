'use client';

import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, FormField, Textarea } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/composite';
import { studioApi, StudioApiError, type SaveDocumentResult } from './studio-client';

interface Props {
  open: boolean;
  documentId: string;
  blockIds: string[];
  onClose: () => void;
  onApplied: (result: SaveDocumentResult) => void;
}

const SUGGESTIONS = [
  'Resume este contenido en un párrafo corto',
  'Corrige ortografía y redacción sin cambiar cifras',
  'Convierte la lista en una tabla con columnas Concepto y Monto',
  'Traduce al inglés manteniendo los montos',
];

/** "Pedir cambio a la IA sobre la selección": only the selected blocks can change. */
export function StudioAiEditDialog({ open, documentId, blockIds, onClose, onApplied }: Props) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (instruction.trim().length < 3) {
      setError('Describe el cambio que quieres (mínimo 3 caracteres).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await studioApi.aiEdit(documentId, {
        blockIds,
        instruction: instruction.trim(),
      });
      setInstruction('');
      onApplied(result);
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'La IA no pudo aplicar el cambio');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Pedir cambio a la IA"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button icon={<Sparkles size={16} />} onClick={submit} isLoading={busy}>
            Aplicar cambio
          </Button>
        </>
      }
    >
      <p className="text-small">
        La IA solo puede modificar los <strong>{blockIds.length}</strong> bloque(s) seleccionados;
        el resto del documento no cambia. El resultado se guarda como una nueva versión que puedes
        restaurar.
      </p>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <FormField label="Instrucción" htmlFor="studio-ai-instruction">
        <Textarea
          id="studio-ai-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="Ej. Resume estos párrafos y conserva todas las cifras"
          disabled={busy}
          autoFocus
        />
      </FormField>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="assistant-suggestion-chip"
            onClick={() => setInstruction(s)}
            disabled={busy}
          >
            {s}
          </button>
        ))}
      </div>
    </Modal>
  );
}
