'use client';

import React, { useEffect, useState } from 'react';
import { Download, MonitorCheck } from 'lucide-react';
import { toast } from 'sonner';

/** Chrome/Edge fire this before offering an install — it's not in TS's DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * "Descargar app" — installs UNIK as a desktop/mobile PWA. The manifest,
 * icons and service worker already ship; this button captures the browser's
 * beforeinstallprompt and fires it, with per-platform instructions as
 * fallback when the browser defers the choice to the user.
 */
export function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
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

  async function handleClick() {
    if (deferred) {
      await deferred.prompt().catch(() => undefined);
      const choice = await deferred.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') setInstalled(true);
      setDeferred(null);
      return;
    }
    const isApple = /iphone|ipad|ipod|macintosh/i.test(window.navigator.userAgent);
    toast.info(
      isApple
        ? 'Para instalar: menú Compartir → "Añadir a pantalla de inicio" (o en Safari de Mac: Archivo → Añadir al Dock).'
        : 'Para instalar: ícono de instalación en la barra de direcciones del navegador, o menú ⋮ → "Instalar UNIK".',
      { duration: 8000 }
    );
  }

  if (installed) {
    return (
      <div className="assistant-sidebar-new agent-install-done" aria-live="polite">
        <MonitorCheck size={16} />
        <span>App instalada</span>
      </div>
    );
  }

  return (
    <button type="button" className="assistant-sidebar-new" onClick={() => void handleClick()}>
      <Download size={16} />
      <span>Descargar app</span>
    </button>
  );
}
