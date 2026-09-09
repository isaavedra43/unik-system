'use client';

import React, { useState, useCallback } from 'react';
import { X, Plus, Trash2, BarChart3 } from 'lucide-react';

export interface ChatPollCreatorProps {
  onCreate: (poll: {
    question: string;
    options: string[];
    isMulti: boolean;
    isAnonymous: boolean;
  }) => void;
  onCancel: () => void;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

export function ChatPollCreator({ onCreate, onCancel }: ChatPollCreatorProps) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [isMulti, setIsMulti] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateOption = useCallback((index: number, value: string) => {
    setOptions((prev) => prev.map((opt, i) => (i === index ? value : opt)));
  }, []);

  const addOption = useCallback(() => {
    setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ''] : prev));
  }, []);

  const removeOption = useCallback((index: number) => {
    setOptions((prev) => (prev.length > MIN_OPTIONS ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const handleCreate = useCallback(() => {
    const trimmedQuestion = question.trim();
    const trimmedOptions = options.map((o) => o.trim()).filter(Boolean);

    if (!trimmedQuestion) {
      setError('Escribe una pregunta');
      return;
    }
    if (trimmedOptions.length < MIN_OPTIONS) {
      setError('Agrega al menos 2 opciones');
      return;
    }
    setError(null);
    onCreate({
      question: trimmedQuestion,
      options: trimmedOptions,
      isMulti,
      isAnonymous,
    });
  }, [question, options, isMulti, isAnonymous, onCreate]);

  return (
    <div className="chat-dialog-overlay" onClick={onCancel}>
      <div className="chat-dialog chat-poll-creator" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>
            <BarChart3 size={20} /> Crear encuesta
          </h2>
          <button type="button" onClick={onCancel} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-poll-creator-body">
          <input
            type="text"
            className="chat-poll-question-input"
            placeholder="Escribe la pregunta..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={300}
          />

          <div className="chat-poll-options">
            {options.map((option, index) => (
              <div key={index} className="chat-poll-option-row">
                <input
                  type="text"
                  className="chat-poll-option-input"
                  placeholder={`Opción ${index + 1}`}
                  value={option}
                  onChange={(e) => updateOption(index, e.target.value)}
                  maxLength={200}
                />
                {options.length > MIN_OPTIONS && (
                  <button
                    type="button"
                    className="chat-poll-option-remove"
                    onClick={() => removeOption(index)}
                    aria-label={`Quitar opción ${index + 1}`}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {options.length < MAX_OPTIONS && (
            <button type="button" className="chat-poll-add-option" onClick={addOption}>
              <Plus size={16} /> Agregar opción
            </button>
          )}

          <div className="chat-poll-settings">
            <label className="chat-poll-setting">
              <input
                type="checkbox"
                checked={isMulti}
                onChange={(e) => setIsMulti(e.target.checked)}
              />
              <span>Selección múltiple</span>
            </label>
            <label className="chat-poll-setting">
              <input
                type="checkbox"
                checked={isAnonymous}
                onChange={(e) => setIsAnonymous(e.target.checked)}
              />
              <span>Voto anónimo</span>
            </label>
          </div>

          {error && <div className="chat-dialog-error">{error}</div>}
        </div>

        <div className="chat-dialog-footer">
          <button type="button" className="chat-poll-cancel-btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="chat-poll-create-btn" onClick={handleCreate}>
            Crear encuesta
          </button>
        </div>
      </div>
    </div>
  );
}
