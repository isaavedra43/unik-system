'use client';

import React, { forwardRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';
import { cn } from '@/lib/utils';
import { AGENT_ICONS, agentHue } from './lib/agents';
import type { AgentInfo, AgentStatus } from './lib/types';

/** Agent avatar: palette color + lucide icon (or initials) + optional status dot. */
export function AgentAvatar({
  agent,
  size = 'md',
  status,
  className,
}: {
  agent: Pick<AgentInfo, 'name' | 'color' | 'icon'>;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  status?: AgentStatus;
  className?: string;
}) {
  const Icon = agent.icon ? AGENT_ICONS[agent.icon] : undefined;
  const iconSize = size === 'lg' ? 24 : size === 'md' ? 15 : size === 'sm' ? 13 : 11;
  const parts = agent.name.trim().split(/\s+/).filter(Boolean);
  const initials =
    parts.length === 0
      ? 'A'
      : parts.length === 1
        ? parts[0].slice(0, 2).toUpperCase()
        : (parts[0][0] + parts[1][0]).toUpperCase();
  return (
    <span
      className={cn('uv-avatar', size !== 'md' && `is-${size}`, className)}
      style={{ background: `var(--agent-hue-${agentHue(agent.color)})` }}
      aria-hidden="true"
    >
      {Icon ? <Icon size={iconSize} strokeWidth={2} /> : initials}
      {status && <span className={cn('uv-avatar-status', status !== 'idle' && `is-${status}`)} />}
    </span>
  );
}

/** Icon button with an accessible name and a tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    tip?: React.ReactNode;
    on?: boolean;
    size?: 'md' | 'sm';
    tipSide?: 'top' | 'bottom' | 'left' | 'right';
  }
>(function IconButton(
  { label, tip, on, size = 'md', tipSide = 'bottom', className, children, ...rest },
  ref
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn('uv-icon-btn', size === 'sm' && 'is-sm', on && 'is-on', className)}
      {...rest}
    >
      {children}
    </button>
  );
  if (tip === false) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tipSide}>{tip ?? label}</TooltipContent>
    </Tooltip>
  );
});

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="uv-kbd">{children}</kbd>;
}

/** Platform modifier label (⌘ on Apple, Ctrl elsewhere) — client only. */
export function modKey(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}
