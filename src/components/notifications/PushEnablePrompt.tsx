'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { BellRing, Bot, Eye, MessageCircle, Phone, Share, SquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { duration, ease } from '@/lib/motion/presets';
import { usePushSubscription } from './usePushSubscription';
import { markPushPromptDismissed, shouldAskPush } from './push-prompt-gate';

/**
 * One-time "turn on notifications" ask, mounted once in the app shell so it can
 * greet a user on their first visit from any page. It only opens on devices
 * that could still receive push — browsers where permission was never decided,
 * and iOS Safari before the app is installed to the home screen.
 *
 * Dismissal and activation are remembered per device in localStorage (browser
 * storage is per-profile, which is exactly the granularity push needs — a user
 * who enabled their laptop still gets asked on their phone). Once answered we
 * never nag again; the banner on /app/notifications and the settings page keep
 * offering activation for anyone who skipped.
 */

export function PushEnablePrompt() {
  const [eligible, setEligible] = useState(false);
  useEffect(() => setEligible(shouldAskPush()), []);
  // The inner component mounts usePushSubscription (one GET) only when the
  // device is actually a candidate — nobody else pays for the fetch.
  if (!eligible) return null;
  return <PromptDialog />;
}

const BENEFITS = [
  { icon: Phone, label: 'Llamadas entrantes, aunque estés fuera de la app' },
  { icon: MessageCircle, label: 'Mensajes de clientes y de tu equipo' },
  { icon: Bot, label: 'Cuando la IA termina algo por ti' },
  { icon: Eye, label: 'Cambios en lo que sigues' },
] as const;

function PromptDialog() {
  const push = usePushSubscription();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (push.status === 'prompt' || push.status === 'needs_install') setOpen(true);
  }, [push.status]);

  const close = useCallback(() => {
    markPushPromptDismissed();
    setOpen(false);
  }, []);

  const activate = async () => {
    const ok = await push.subscribe();
    if (ok) {
      close();
      toast.success('Listo — te avisaremos en este dispositivo');
      return;
    }
    // The browser said "no" in the native prompt: remember it, don't nag —
    // the settings page explains how to re-enable from the address bar.
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') close();
  };

  const install = push.status === 'needs_install';
  const deviceNoun = push.ios ? 'este iPhone' : 'este dispositivo';

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <div className="flex flex-col items-center gap-4 pt-1 text-center">
          <motion.div
            initial={reduceMotion ? false : { scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={ease.spring}
            className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"
          >
            <motion.span
              initial={{ rotate: 0 }}
              animate={reduceMotion ? {} : { rotate: [0, -14, 12, -8, 4, 0] }}
              transition={{ duration: 0.9, delay: 0.4, ease: 'easeInOut' }}
              className="origin-top"
            >
              <BellRing className="size-7" />
            </motion.span>
          </motion.div>
          <DialogHeader className="items-center text-center sm:items-center sm:text-center">
            <DialogTitle className="text-xl">
              {install ? 'Recibe UNIK en tu iPhone' : 'Activa las notificaciones'}
            </DialogTitle>
            <DialogDescription>
              {install
                ? 'Para que UNIK te avise en iPhone o iPad, primero agrégala a tu pantalla de inicio.'
                : `Te avisamos en ${deviceNoun} aunque no tengas UNIK abierto. Solo es un toque.`}
            </DialogDescription>
          </DialogHeader>
        </div>

        {install ? (
          <ol className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/40 p-4 text-sm">
            <li className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                1
              </span>
              <span className="flex items-center gap-1.5">
                Toca <Share className="size-4 shrink-0 text-primary" /> <strong>Compartir</strong>{' '}
                en Safari
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                2
              </span>
              <span className="flex items-center gap-1.5">
                Elige{' '}
                <strong className="inline-flex items-center gap-1">
                  <SquarePlus className="size-4 shrink-0 text-primary" /> Agregar a pantalla de
                  inicio
                </strong>
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                3
              </span>
              <span>Abre UNIK desde el ícono nuevo y activa las notificaciones aquí.</span>
            </li>
          </ol>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {BENEFITS.map((b, i) => (
              <motion.li
                key={b.label}
                initial={reduceMotion ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  duration: duration.normal,
                  ease: ease.out,
                  delay: 0.15 + i * 0.05,
                }}
                className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm"
              >
                <b.icon className="size-4 shrink-0 text-primary" />
                <span>{b.label}</span>
              </motion.li>
            ))}
          </ul>
        )}

        {push.error ? <p className="text-sm text-destructive">{push.error}</p> : null}

        <DialogFooter>
          {install ? (
            <Button className="w-full" onClick={close}>
              Entendido
            </Button>
          ) : (
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={close} className="sm:mr-auto">
                Ahora no
              </Button>
              <Button onClick={() => void activate()} disabled={push.busy}>
                <BellRing /> {push.busy ? 'Activando…' : 'Activar notificaciones'}
              </Button>
            </div>
          )}
        </DialogFooter>
        <p className="text-center text-xs text-muted-foreground">
          Puedes cambiarlo cuando quieras en tu perfil → Mis notificaciones.
        </p>
      </DialogContent>
    </Dialog>
  );
}
