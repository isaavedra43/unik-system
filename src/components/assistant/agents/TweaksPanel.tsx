'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { Moon, Sliders, Sun, SunMoon, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { scaleIn } from '@/lib/motion';
import type { AssistantTweaks } from './useAssistantTweaks';

/**
 * Tweaks FAB — theme, density, ops-panel visibility, animations and the
 * composer's default mode. Theme goes through the global next-themes system;
 * the rest persists in localStorage.
 */
export function TweaksPanel({
  tweaks,
  setTweaks,
}: {
  tweaks: AssistantTweaks;
  setTweaks: (patch: Partial<AssistantTweaks>) => void;
}) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="tweaks-root" ref={panelRef}>
      <AnimatePresence>
        {open && (
          <motion.div
            className="tweaks-panel"
            role="dialog"
            aria-label="Ajustes de la vista"
            variants={scaleIn}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <div className="tweaks-head">
              <span>Ajustes de vista</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar ajustes">
                <X size={14} />
              </button>
            </div>

            <div className="tweaks-row">
              <span className="tweaks-label">Tema</span>
              <div className="tweaks-seg" role="radiogroup" aria-label="Tema">
                {(
                  [
                    { v: 'light', icon: <Sun size={13} />, label: 'Claro' },
                    { v: 'dark', icon: <Moon size={13} />, label: 'Oscuro' },
                    { v: 'system', icon: <SunMoon size={13} />, label: 'Auto' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    role="radio"
                    aria-checked={theme === o.v}
                    className={cn('tweaks-seg-btn', theme === o.v && 'is-active')}
                    onClick={() => setTheme(o.v)}
                    title={o.label}
                  >
                    {o.icon}
                  </button>
                ))}
              </div>
            </div>

            <div className="tweaks-row">
              <span className="tweaks-label">Densidad</span>
              <div className="tweaks-seg" role="radiogroup" aria-label="Densidad">
                {(
                  [
                    { v: 'normal', label: 'Normal' },
                    { v: 'compact', label: 'Compacta' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    role="radio"
                    aria-checked={tweaks.density === o.v}
                    className={cn(
                      'tweaks-seg-btn',
                      'is-text',
                      tweaks.density === o.v && 'is-active'
                    )}
                    onClick={() => setTweaks({ density: o.v })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="tweaks-row">
              <span className="tweaks-label">Panel de operación</span>
              <button
                type="button"
                role="switch"
                aria-checked={tweaks.opsVisible}
                className={cn('tweaks-switch', tweaks.opsVisible && 'is-on')}
                onClick={() => setTweaks({ opsVisible: !tweaks.opsVisible })}
              >
                <span className="tweaks-switch-dot" />
              </button>
            </div>

            <div className="tweaks-row">
              <span className="tweaks-label">Animaciones</span>
              <button
                type="button"
                role="switch"
                aria-checked={tweaks.animations}
                className={cn('tweaks-switch', tweaks.animations && 'is-on')}
                onClick={() => setTweaks({ animations: !tweaks.animations })}
              >
                <span className="tweaks-switch-dot" />
              </button>
            </div>

            <div className="tweaks-row">
              <span className="tweaks-label">Redactor por defecto</span>
              <div className="tweaks-seg" role="radiogroup" aria-label="Modo del redactor">
                {(
                  [
                    { v: 'mission', label: 'Misión' },
                    { v: 'message', label: 'Mensaje' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    role="radio"
                    aria-checked={tweaks.composerMode === o.v}
                    className={cn(
                      'tweaks-seg-btn',
                      'is-text',
                      tweaks.composerMode === o.v && 'is-active'
                    )}
                    onClick={() => setTweaks({ composerMode: o.v })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        className="tweaks-fab"
        onClick={() => setOpen((v) => !v)}
        aria-label="Ajustes de la vista"
        aria-expanded={open}
        title="Ajustes de vista"
      >
        <Sliders size={17} />
      </button>
    </div>
  );
}
