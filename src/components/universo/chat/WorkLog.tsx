'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Loader2,
  PanelRight,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LiveToolCall, ToolRecord, WorkspaceTab } from '../lib/types';
import { HIDDEN_STEP_TOOLS, stepLabel, toolIcon } from '../lib/tools';
import { workspaceTabForTool } from '../lib/agents';
import { formatDuration } from '../lib/format';

/**
 * "How the agent got here" — the reasoning plus every tool it used, as one
 * collapsible timeline (ChatGPT's thinking rail + Claude's tool blocks). Live
 * while the answer streams, a one-line summary afterwards.
 */

export type StepStatus = 'running' | 'done' | 'failed' | 'pending';

export interface StepView {
  key: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: StepStatus;
  durationMs?: number;
  cached?: boolean;
  errorCode?: string | null;
}

export function stepsFromRecords(records: ToolRecord[]): StepView[] {
  return records
    .filter((r) => !HIDDEN_STEP_TOOLS.has(r.toolName))
    .map((r) => ({
      key: r.id,
      name: r.toolName,
      args: r.args,
      result: r.result,
      status: r.errorCode === 'needs_approval' ? 'pending' : r.success ? 'done' : 'failed',
      durationMs: r.durationMs,
      cached: Boolean(
        r.result &&
        typeof r.result === 'object' &&
        (r.result as { cached?: unknown }).cached === true
      ),
      errorCode: r.errorCode,
    }));
}

export function stepsFromLive(calls: LiveToolCall[]): StepView[] {
  return calls
    .filter((c) => !HIDDEN_STEP_TOOLS.has(c.name))
    .map((c) => ({
      key: c.key,
      name: c.name,
      args: c.args,
      status: c.success === undefined ? 'running' : c.success ? 'done' : 'failed',
      durationMs: c.durationMs,
    }));
}

function StatusIcon({ step }: { step: StepView }) {
  if (step.status === 'running') return <Loader2 size={12} className="uv-spin" />;
  if (step.status === 'failed') return <X size={12} />;
  if (step.status === 'pending') return <Clock size={12} />;
  const Icon = toolIcon(step.name);
  return <Icon size={12} />;
}

function stringify(value: unknown, max = 6000): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function StepDetail({ step }: { step: StepView }) {
  // Terminal commands read like a terminal.
  if (step.name === 'venueExec') {
    const a = (step.args ?? {}) as { command?: string };
    const r = (step.result ?? {}) as { output?: string; exitCode?: number; note?: string };
    return (
      <div className="uv-step-detail">
        <pre className="uv-pre">
          <span className="uv-tok-s">$ </span>
          {a.command}
          {r.output ? `\n${stringify(r.output, 4000)}` : ''}
          {typeof r.exitCode === 'number' && r.exitCode !== 0
            ? `\n[código de salida ${r.exitCode}]`
            : ''}
        </pre>
        {r.note && <span className="uv-step-meta">{r.note}</span>}
      </div>
    );
  }
  const error =
    step.errorCode && step.errorCode !== 'needs_approval'
      ? step.errorCode
      : step.result &&
          typeof step.result === 'object' &&
          typeof (step.result as { error?: unknown }).error === 'string'
        ? String((step.result as { error: string }).error)
        : null;
  return (
    <div className="uv-step-detail">
      {step.args !== undefined && step.args !== null && stringify(step.args) !== '{}' && (
        <>
          <span className="uv-step-detail-label">Entrada</span>
          <pre className="uv-pre">{stringify(step.args, 3000)}</pre>
        </>
      )}
      {error ? (
        <>
          <span className="uv-step-detail-label">Error</span>
          <pre className="uv-pre">{error}</pre>
        </>
      ) : step.result !== undefined && step.result !== null ? (
        <>
          <span className="uv-step-detail-label">Resultado</span>
          <pre className="uv-pre">{stringify(step.result)}</pre>
        </>
      ) : null}
      <span className="uv-step-meta">{step.name}</span>
    </div>
  );
}

export function WorkLog({
  reasoning,
  steps,
  live = false,
  elapsedMs,
  onOpenWorkspace,
}: {
  reasoning?: string | null;
  steps: StepView[];
  live?: boolean;
  /** Turn duration (live: since the send; persisted: sum of tool time). */
  elapsedMs?: number;
  onOpenWorkspace?: (tab: WorkspaceTab) => void;
}) {
  const [open, setOpen] = useState(live);
  const [detail, setDetail] = useState<string | null>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const hasReasoning = Boolean(reasoning && reasoning.trim());

  // Live: follow the newest thought.
  useEffect(() => {
    if (!live || !open) return;
    const el = reasoningRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, live, open]);

  // Opens while it streams, folds itself when the answer lands.
  useEffect(() => {
    setOpen(live);
  }, [live]);

  const icons = useMemo(() => {
    const seen: string[] = [];
    for (const s of [...steps].reverse()) {
      if (!seen.includes(s.name)) seen.push(s.name);
      if (seen.length === 3) break;
    }
    return seen.reverse();
  }, [steps]);

  if (!hasReasoning && steps.length === 0) return null;

  const running = steps.find((s) => s.status === 'running');
  const failed = steps.filter((s) => s.status === 'failed').length;
  const surface = steps.map((s) => workspaceTabForTool(s.name)).find(Boolean) ?? null;
  const seconds = elapsedMs && elapsedMs > 900 ? formatDuration(elapsedMs) : '';

  let headline: React.ReactNode;
  if (live) {
    headline = (
      <span className="uv-shimmer-text">
        {running
          ? stepLabel(running.name, running.args, true)
          : hasReasoning && steps.length === 0
            ? 'Pensando…'
            : 'Trabajando…'}
      </span>
    );
  } else {
    const parts: string[] = [];
    if (hasReasoning) parts.push(steps.length > 0 ? 'Pensó' : 'Razonamiento');
    if (steps.length > 0) parts.push(`${steps.length} paso${steps.length > 1 ? 's' : ''}`);
    if (failed > 0) parts.push(`${failed} con error`);
    if (seconds) parts.push(seconds);
    headline = <span>{parts.join(' · ')}</span>;
  }

  return (
    <div className={cn('uv-activity', live && 'is-live')}>
      <button
        type="button"
        className="uv-activity-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {live ? (
          <Loader2 size={14} className="uv-spin" />
        ) : hasReasoning && steps.length === 0 ? (
          <Brain size={14} />
        ) : (
          <Check size={14} />
        )}
        {headline}
        {live && seconds && <span className="uv-step-meta">{seconds}</span>}
        <span className="uv-activity-icons" aria-hidden="true">
          {icons.map((n) => {
            const Icon = toolIcon(n);
            return (
              <span key={n}>
                <Icon size={11} />
              </span>
            );
          })}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="uv-activity-body">
          {hasReasoning && (
            <div className="uv-reasoning-body" ref={reasoningRef}>
              {reasoning}
            </div>
          )}
          {steps.length > 0 && (
            <ol className="uv-steps" aria-label="Pasos del agente">
              {steps.map((s) => {
                const isOpen = detail === s.key;
                return (
                  <li key={s.key} className={cn('uv-step', `is-${s.status}`)}>
                    <span className="uv-step-icon">
                      <StatusIcon step={s} />
                    </span>
                    <div className="uv-step-main">
                      <button
                        type="button"
                        className="uv-step-line"
                        onClick={() => setDetail(isOpen ? null : s.key)}
                        aria-expanded={isOpen}
                        disabled={s.status === 'running'}
                      >
                        <span className="uv-step-label">
                          {s.status === 'pending'
                            ? `${stepLabel(s.name, s.args, false)} · espera tu aprobación`
                            : stepLabel(s.name, s.args, s.status === 'running')}
                        </span>
                        {s.cached && (
                          <span className="uv-step-meta" title="Resultado reciente reutilizado">
                            <Database size={11} />
                          </span>
                        )}
                        {s.durationMs !== undefined && s.status !== 'running' && (
                          <span className="uv-step-meta">{formatDuration(s.durationMs)}</span>
                        )}
                      </button>
                      {isOpen && <StepDetail step={s} />}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {surface && onOpenWorkspace && (
            <div className="uv-activity-foot">
              <button
                type="button"
                className="uv-btn is-ghost is-sm"
                onClick={() => onOpenWorkspace(surface)}
              >
                <PanelRight size={13} />
                {surface === 'browser'
                  ? 'Ver el navegador'
                  : surface === 'computer'
                    ? 'Ver la computadora'
                    : surface === 'files'
                      ? 'Ver los archivos'
                      : 'Ver al equipo'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
