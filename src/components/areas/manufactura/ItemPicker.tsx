'use client';

import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/primitives';

export interface PickedItem {
  zohoItemId: string;
  sku: string | null;
  name: string;
  unit: string | null;
}

export interface ItemPickerProps {
  id: string;
  /** Selected item id (the form keeps it; this component only helps find it). */
  value: string;
  onChange: (item: PickedItem | null, rawValue: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Area the lookup runs under (always `manufactura` in these pages). */
  areaKey?: string;
}

const MIN_TERM = 2;
const DEBOUNCE_MS = 250;

/**
 * Product lookup of the manufacturing forms: type a SKU or a name, pick the
 * item. It is a plain input with a `datalist`, so it works with the keyboard and
 * with a barcode scanner (which just types the code and presses Enter) without
 * adding a combobox dependency.
 *
 * The catalogue comes from the area API, which requires `manufacturing.view`.
 */
export function ItemPicker({
  id,
  value,
  onChange,
  placeholder = 'SKU o nombre del producto',
  disabled = false,
  required = false,
  areaKey = 'manufactura',
}: ItemPickerProps) {
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<PickedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const listId = `${id}-options`;

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < MIN_TERM) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/app/areas/${encodeURIComponent(areaKey)}/api/manufactura/items?q=${encodeURIComponent(trimmed)}`,
          { credentials: 'same-origin' }
        );
        const json = (await response.json().catch(() => ({}))) as { data?: PickedItem[] };
        if (!cancelled) setOptions(Array.isArray(json.data) ? json.data : []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, areaKey]);

  const byLabel = useMemo(() => {
    const map = new Map<string, PickedItem>();
    for (const option of options) {
      map.set(optionLabel(option), option);
      map.set(option.zohoItemId, option);
      if (option.sku) map.set(option.sku, option);
    }
    return map;
  }, [options]);

  return (
    <>
      <Input
        id={id}
        list={listId}
        value={term || value}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        autoComplete="off"
        onChange={(event) => {
          const next = event.target.value;
          setTerm(next);
          const match = byLabel.get(next) ?? null;
          onChange(match, match ? match.zohoItemId : next);
        }}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.zohoItemId} value={optionLabel(option)} />
        ))}
      </datalist>
      {loading ? (
        <span className="mfg-section-hint" role="status">
          Buscando…
        </span>
      ) : null}
    </>
  );
}

function optionLabel(item: PickedItem): string {
  return item.sku ? `${item.sku} · ${item.name}` : item.name;
}
