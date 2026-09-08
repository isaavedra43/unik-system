'use client';

import React, { useRef, useState, useEffect } from 'react';
import { Send } from 'lucide-react';

export interface AssistantInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  streaming?: boolean;
  maxLength?: number;
  placeholder?: string;
}

export function AssistantInput({
  onSend,
  disabled,
  streaming,
  maxLength = 10_000,
  placeholder = 'Escribe tu mensaje…',
}: AssistantInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !disabled && !streaming;

  function handleSend() {
    if (!canSend) return;
    onSend(value.trim());
    setValue('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="assistant-input">
      <textarea
        ref={textareaRef}
        className="assistant-input-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, maxLength))}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="Mensaje al asistente"
      />
      <button
        type="button"
        className="assistant-input-send"
        onClick={handleSend}
        disabled={!canSend}
        aria-label="Enviar mensaje"
      >
        {streaming ? <span className="spinner" aria-hidden="true" /> : <Send size={18} />}
      </button>
      {maxLength > 0 && value.length > maxLength * 0.8 && (
        <span className="assistant-input-counter">
          {value.length}/{maxLength}
        </span>
      )}
    </div>
  );
}
