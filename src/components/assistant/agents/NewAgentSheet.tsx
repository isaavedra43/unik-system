'use client';

import React, { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import {
  AGENT_HUE_COUNT,
  AGENT_ICON_KEYS,
  AGENT_ICONS,
  agentFromRecord,
  type AgentInfo,
  type AgentRecordDTO,
} from './agent-types';
import { AgentAvatar } from './AgentAvatar';

/** Suggestion presets — clicking one pre-fills name/purpose/icon/color. */
export const AGENT_SUGGESTIONS: Array<{
  name: string;
  purpose: string;
  icon: string;
  color: number;
}> = [
  {
    name: 'Cobranza',
    purpose: 'Persigue facturas vencidas y confirma pagos con clientes.',
    icon: 'sales',
    color: 4,
  },
  {
    name: 'Investigador Web',
    purpose: 'Investiga en internet y te trae resúmenes con fuentes.',
    icon: 'research',
    color: 1,
  },
  {
    name: 'Analista de Datos',
    purpose: 'Cruza ventas, inventario y pagos para encontrar patrones.',
    icon: 'data',
    color: 2,
  },
  {
    name: 'Vigía',
    purpose: 'Vigila indicadores y te avisa cuando algo se sale de rango.',
    icon: 'watch',
    color: 3,
  },
];

export interface NewAgentSheetProps {
  open: boolean;
  onClose: () => void;
  /** false while POST /app/assistant/api/agents does not exist — the form stays
   *  fully usable visually but cannot submit (no fake success). */
  supported: boolean;
  /** Pre-fill from an empty-state suggestion card. */
  template?: { name: string; purpose: string; icon: string; color: number } | null;
  onCreated?: (agent: AgentInfo) => void;
}

export function NewAgentSheet({
  open,
  onClose,
  supported,
  template,
  onCreated,
}: NewAgentSheetProps) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [color, setColor] = useState(1);
  const [icon, setIcon] = useState('research');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedKey = React.useRef<string | null>(null);

  // Apply the suggestion card the parent passed (once per open).
  React.useEffect(() => {
    if (!open) return;
    if (template && appliedKey.current !== template.name) {
      appliedKey.current = template.name;
      setName(template.name);
      setPurpose(template.purpose);
      setIcon(template.icon);
      setColor(template.color);
    }
    if (!template) appliedKey.current = null;
    setError(null);
  }, [open, template]);

  const preview: AgentInfo = {
    id: 'preview',
    name: name || 'Agente',
    kind: 'specialist',
    color,
    icon,
  };
  const canSubmit = supported && name.trim().length > 0 && !busy;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/app/assistant/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          purpose: purpose.trim() || undefined,
          color: String(color),
          icon,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error ?? 'No se pudo crear el agente');
      }
      const d = (await res.json()) as { agent?: AgentRecordDTO };
      onCreated?.(
        d.agent
          ? agentFromRecord(d.agent)
          : {
              id: `agent-${Date.now()}`,
              name: name.trim(),
              kind: 'specialist',
              purpose,
              color,
              icon,
            }
      );
      toast.success(`${name.trim()} se unió al equipo`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el agente');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="agent-sheet">
        <DialogHeader>
          <DialogTitle>Nuevo agente</DialogTitle>
          <DialogDescription>
            Un especialista con su propio chat, misiones y herramientas.
          </DialogDescription>
        </DialogHeader>

        <form className="agent-sheet-form" onSubmit={handleSubmit}>
          <div className="agent-sheet-preview">
            <AgentAvatar agent={preview} size="lg" />
            <div>
              <div className="agent-sheet-preview-name">{name || 'Sin nombre'}</div>
              <div className="agent-sheet-preview-sub">{purpose || 'Describe su propósito'}</div>
            </div>
          </div>

          <div className="agent-sheet-suggestions" role="listbox" aria-label="Sugerencias">
            {AGENT_SUGGESTIONS.map((s) => (
              <button
                key={s.name}
                type="button"
                className="agent-suggestion"
                onClick={() => {
                  setName(s.name);
                  setPurpose(s.purpose);
                  setIcon(s.icon);
                  setColor(s.color);
                }}
              >
                <AgentAvatar agent={{ name: s.name, color: s.color, icon: s.icon }} size="xs" />
                <span>
                  <span className="agent-suggestion-name">{s.name}</span>
                  <span className="agent-suggestion-sub">{s.purpose}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="agent-sheet-field">
            <span className="agent-sheet-label">Color</span>
            <div className="agent-color-row" role="radiogroup" aria-label="Color del agente">
              {Array.from({ length: AGENT_HUE_COUNT }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={color === i}
                  aria-label={`Color ${i + 1}`}
                  className={cn('agent-color-swatch', color === i && 'is-active')}
                  style={{ background: `var(--agent-hue-${i})` }}
                  onClick={() => setColor(i)}
                >
                  {color === i && <Check size={12} />}
                </button>
              ))}
            </div>
          </div>

          <div className="agent-sheet-field">
            <span className="agent-sheet-label">Icono</span>
            <div className="agent-icon-row" role="radiogroup" aria-label="Icono del agente">
              {AGENT_ICON_KEYS.map((key) => {
                const Ic = AGENT_ICONS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={icon === key}
                    aria-label={`Icono ${key}`}
                    className={cn('agent-icon-swatch', icon === key && 'is-active')}
                    onClick={() => setIcon(key)}
                  >
                    <Ic size={15} />
                  </button>
                );
              })}
            </div>
          </div>

          <label className="agent-sheet-field">
            <span className="agent-sheet-label">Nombre</span>
            <input
              type="text"
              className="agent-sheet-input"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 60))}
              placeholder="Cobranza"
              maxLength={60}
            />
          </label>

          <label className="agent-sheet-field">
            <span className="agent-sheet-label">Propósito</span>
            <textarea
              className="agent-sheet-input agent-sheet-textarea"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value.slice(0, 280))}
              placeholder="Qué hace, para quién, con qué datos"
              rows={3}
              maxLength={280}
            />
          </label>

          {error && (
            <div className="agent-sheet-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="agent-btn-primary"
            disabled={!canSubmit}
            title={!supported ? 'Disponible próximamente' : undefined}
          >
            {busy ? <Loader2 size={14} className="copilot-spin" /> : null}
            Crear agente
          </button>
          {!supported && (
            <p className="agent-sheet-note" role="note">
              Disponible próximamente — el servicio de agentes aún no está activado.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
