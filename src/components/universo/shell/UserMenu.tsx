'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import {
  ChevronsUpDown,
  Download,
  Monitor,
  Moon,
  Palette,
  Puzzle,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { initials } from '../lib/format';
import type { UniversoPrefs } from '../lib/prefs';

/** Chrome/Edge fire this before offering an install (not in TS's DOM lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(
      window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as { standalone?: boolean }).standalone === true
    );
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const install = async () => {
    if (deferred) {
      await deferred.prompt().catch(() => undefined);
      const choice = await deferred.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') setInstalled(true);
      setDeferred(null);
      return;
    }
    const apple = /iphone|ipad|ipod|macintosh/i.test(window.navigator.userAgent);
    toast.info(
      apple
        ? 'Para instalar: menú Compartir → «Añadir a pantalla de inicio» (en Safari de Mac: Archivo → Añadir al Dock).'
        : 'Para instalar: ícono de instalación en la barra de direcciones, o menú ⋮ → «Instalar UNIK».',
      { duration: 8000 }
    );
  };
  return { installed, install };
}

export function UserMenu({
  name,
  username,
  prefs,
  setPrefs,
  onOpenPreferences,
}: {
  name: string;
  username?: string;
  prefs: UniversoPrefs;
  setPrefs: (patch: Partial<UniversoPrefs>) => void;
  onOpenPreferences: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const { installed, install } = useInstallPrompt();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="uv-user-btn" aria-label="Tu cuenta y preferencias">
          <span className="uv-user-avatar">{initials(name)}</span>
          <span className="uv-row-text">
            <span className="uv-row-title">
              <span>{name}</span>
            </span>
            {username && <span className="uv-row-sub">@{username}</span>}
          </span>
          <ChevronsUpDown size={15} style={{ color: 'var(--unik-text-muted)' }} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="uv-pop uv-scope"
        style={{ width: 260 }}
      >
        <DropdownMenuLabel className="uv-pop-title">Asistente</DropdownMenuLabel>
        <DropdownMenuItem className="uv-menu-item" onSelect={onOpenPreferences}>
          <SlidersHorizontal size={15} /> Preferencias y memoria
        </DropdownMenuItem>
        <DropdownMenuItem className="uv-menu-item" asChild>
          <Link href="/app/assistant/extensions">
            <Puzzle size={15} /> Apps, extensiones y skills
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="uv-menu-item">
            <Palette size={15} /> Apariencia
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="uv-pop uv-scope" style={{ width: 220 }}>
            <DropdownMenuRadioGroup value={theme ?? 'light'} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light" className="uv-menu-item">
                <Sun size={14} /> Claro
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" className="uv-menu-item">
                <Moon size={14} /> Oscuro
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system" className="uv-menu-item">
                <Monitor size={14} /> Como el sistema
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              className="uv-menu-item"
              checked={prefs.density === 'compact'}
              onCheckedChange={(v) => setPrefs({ density: v ? 'compact' : 'comfortable' })}
            >
              Vista compacta
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              className="uv-menu-item"
              checked={prefs.animations}
              onCheckedChange={(v) => setPrefs({ animations: Boolean(v) })}
            >
              Animaciones
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem
          className="uv-menu-item"
          checked={prefs.composerMode === 'mission'}
          onCheckedChange={(v) => setPrefs({ composerMode: v ? 'mission' : 'message' })}
        >
          Empezar en modo Misión
        </DropdownMenuCheckboxItem>
        {!installed && (
          <DropdownMenuItem className="uv-menu-item" onSelect={() => void install()}>
            <Download size={15} /> Instalar la app
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
