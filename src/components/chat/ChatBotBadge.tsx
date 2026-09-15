'use client';

import React from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ChatBotBadgeProps {
  className?: string;
  /** Show the Bot icon before the label. */
  withIcon?: boolean;
}

/** "IA" marker for AI (bot) users of the agents layer in the chat. */
export function ChatBotBadge({ className, withIcon = false }: ChatBotBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-primary',
        className
      )}
      title="Asistente de IA"
    >
      {withIcon && <Bot size={10} aria-hidden="true" />}
      <span aria-hidden="true">IA</span>
      <span className="sr-only">Asistente de IA</span>
    </span>
  );
}
