'use client';

import React from 'react';

const SUGGESTIONS_BY_PAGE: Record<string, string[]> = {
  '/app': [
    'Dame un resumen del día',
    '¿Cuántas ventas hubo hoy?',
    '¿Cuál es el total de ventas en efectivo del día?',
    'Muéstrame los productos más vendidos',
  ],
  '/app/sales/orders': [
    '¿Cuáles son las ventas en efectivo del día?',
    '¿Cuál es el total de ventas de hoy?',
    'Ventas por vendedor este mes',
    'Top 10 productos más vendidos',
    'Órdenes con saldo pendiente',
    'Compara ventas de esta semana vs la anterior',
  ],
};

const DEFAULT_SUGGESTIONS = [
  '¿Cuáles son las ventas en efectivo del día?',
  'Dame un resumen de ventas de hoy',
  'Muéstrame los productos más vendidos',
  'Ventas por vendedor este mes',
];

export function getSuggestionsForPage(page: string | undefined): string[] {
  if (!page) return DEFAULT_SUGGESTIONS;
  if (SUGGESTIONS_BY_PAGE[page]) return SUGGESTIONS_BY_PAGE[page];
  for (const key of Object.keys(SUGGESTIONS_BY_PAGE)) {
    if (page.startsWith(key)) return SUGGESTIONS_BY_PAGE[key];
  }
  return DEFAULT_SUGGESTIONS;
}

export function AssistantSuggestions({
  suggestions,
  onSelect,
}: {
  suggestions: string[];
  onSelect: (s: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="assistant-suggestions">
      {suggestions.map((s, idx) => (
        <button
          key={idx}
          type="button"
          className="assistant-suggestion-chip"
          onClick={() => onSelect(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
