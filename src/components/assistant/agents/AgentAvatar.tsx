import React from 'react';
import { cn } from '@/lib/utils';
import {
  AGENT_ICONS,
  agentHue,
  agentInitials,
  type AgentInfo,
  type AgentStatus,
} from './agent-types';

/**
 * Round avatar with the agent's palette color, lucide icon (or initials)
 * and an optional status dot. Sizes: xs (sidebar), sm (chat head), lg (hero).
 */
export function AgentAvatar({
  agent,
  size = 'xs',
  status,
  className,
}: {
  agent: Pick<AgentInfo, 'name' | 'color' | 'icon'>;
  size?: 'xs' | 'sm' | 'lg';
  status?: AgentStatus;
  className?: string;
}) {
  const Icon = agent.icon ? AGENT_ICONS[agent.icon] : undefined;
  return (
    <span
      className={cn('agent-avatar', `agent-avatar-${size}`, className)}
      style={{ background: `var(--agent-hue-${agentHue(agent.color)})` }}
      aria-hidden="true"
    >
      {Icon ? (
        <Icon size={size === 'lg' ? 22 : size === 'sm' ? 15 : 14} strokeWidth={1.9} />
      ) : (
        <span className="agent-avatar-initials">{agentInitials(agent.name)}</span>
      )}
      {status && status !== 'offline' && (
        <span className={cn('agent-status-dot', `is-${status}`)} aria-hidden="true" />
      )}
    </span>
  );
}
