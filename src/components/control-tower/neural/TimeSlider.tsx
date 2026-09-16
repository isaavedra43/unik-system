'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

export interface TimeSliderProps {
  /** Texto del control (visible). */
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Cómo se lee la posición actual ("12 mar 2026, 14:05" o "evento 7 de 32"). */
  formatValue: (value: number) => string;
  /** Extremos de la barra (opcionales). */
  minLabel?: string;
  maxLabel?: string;
  /** Frase de ayuda debajo del control. */
  description?: string;
  disabled?: boolean;
  /** Contenido a la derecha del valor (por ejemplo, el botón de reproducir). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Deslizador de tiempo (plan 7.8c y 7.8d): un `input[type=range]` NATIVO, que
 * ya trae teclado (←/→, Inicio/Fin), soporte de lector de pantalla y arrastre
 * táctil sin escribir una línea de JavaScript para ello.
 *
 * Es presentacional: quién decide qué significa cada posición es quien lo monta
 * (un instante en el grafo, un evento en el reproductor).
 */
export function TimeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  formatValue,
  minLabel,
  maxLabel,
  description,
  disabled = false,
  actions,
  className,
}: TimeSliderProps) {
  const id = useId();
  const describedBy = description ? `${id}-help` : undefined;
  const safeMax = Math.max(min, max);
  const current = Math.min(Math.max(value, min), safeMax);

  return (
    <div className={cn('neural-slider', className)}>
      <label className="neural-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="neural-slider-row">
        <input
          id={id}
          type="range"
          min={min}
          max={safeMax}
          step={step}
          value={current}
          disabled={disabled || safeMax === min}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-valuetext={formatValue(current)}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        />
        <span className="neural-slider-value" aria-live="polite">
          {formatValue(current)}
        </span>
        {actions}
      </div>
      {minLabel || maxLabel ? (
        <div className="neural-slider-ends" aria-hidden="true">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      ) : null}
      {description ? (
        <p id={describedBy} className="neural-panel-hint">
          {description}
        </p>
      ) : null}
    </div>
  );
}
