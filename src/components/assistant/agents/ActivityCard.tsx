'use client';

import React, { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Monitor, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolLabel, toolStepLabel } from '@/components/copilot/copilot-types';
import type { ToolCallRecordDisplay } from '../AssistantMessage';
import { AgentAvatar } from './AgentAvatar';
import type { AgentInfo } from './agent-types';

/** Venue/browser tools — their result is visible in the ops panel screen. */
const PANEL_TOOLS = new Set(['browser', 'venueExec', 'venueScreenshot']);

/**
 * Collapsible "actividad" card inside a message: one row per venue/browser
 * tool call, tagged with the agent that ran it. Other tools stay as chips.
 */
export function ActivityCard({
  records,
  agent,
}: {
  records: ToolCallRecordDisplay[];
  agent?: AgentInfo | null;
}) {
  const [open, setOpen] = useState(false);
  if (records.length === 0) return null;
  const tag = agent ?? { name: 'UNIK Central', color: 0, icon: 'central' };
  return (
    <div className="activity-card">
      <button
        type="button"
        className="activity-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <AgentAvatar agent={tag} size="xs" />
        <span className="activity-card-agent">{tag.name}</span>
        <span className="activity-card-count">
          {records.length} {records.length === 1 ? 'actividad' : 'actividades'}
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <ul className="activity-card-list">
          {records.map((r) => {
            const pending = r.errorCode === 'needs_approval';
            const baseTool = r.toolName.split('.')[0];
            const inPanel = PANEL_TOOLS.has(r.toolName) || PANEL_TOOLS.has(baseTool);
            return (
              <li
                key={r.id}
                className={cn(
                  'activity-row',
                  pending ? 'is-pending' : r.success ? 'is-done' : 'is-failed'
                )}
              >
                <span className="activity-row-check">
                  {pending ? (
                    <Monitor size={12} />
                  ) : r.success ? (
                    <Check size={12} />
                  ) : (
                    <X size={12} />
                  )}
                </span>
                <span className="activity-row-text">
                  {pending
                    ? `${toolLabel(r.toolName, 'done')} · esperando aprobación`
                    : toolStepLabel(r.toolName, r.args, 'done')}
                </span>
                <span className="activity-row-tool">{r.toolName}</span>
                {inPanel && <span className="activity-row-badge">captura en panel →</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
