import type { LucideIcon } from 'lucide-react';
import {
  BookOpenCheck,
  Brain,
  ChartColumn,
  Code,
  Cpu,
  Eye,
  Globe,
  HandCoins,
  LifeBuoy,
  Megaphone,
  ShieldCheck,
} from 'lucide-react';

/**
 * Multi-agent shell ("UNIVERSO") — shared types and the avatar palette.
 *
 * `GET /app/assistant/api/agents` does not exist yet: everything here is
 * written so the UI degrades to the single built-in Principal agent (the
 * assistant itself, which is real) and hides specialist-only surfaces.
 */

export type AgentStatus = 'idle' | 'working' | 'offline';

/** Workspace surfaces (third column): what the team is doing right now. */
export type WorkspaceTab = 'browser' | 'computer' | 'team' | 'files';

/** Tool → surface that should come to the front when it runs. */
export function workspaceTabForTool(tool: string): WorkspaceTab | null {
  if (/^(browser|browserProfile|venueScreenshot)/.test(tool)) return 'browser';
  if (/^venue/.test(tool) || /Playbook$/.test(tool)) return 'computer';
  if (/^(web_search|web_research|web_crawl|fetch_url)$/.test(tool)) return 'browser';
  if (
    /^(generate(Pdf|Excel|Word|Csv)|generateImage|generateVideo|composeDocument|generateChart|generateReportImage)/.test(
      tool
    )
  )
    return 'files';
  if (/^(delegateTask|proposeMission)$/.test(tool)) return 'team';
  return null;
}

export interface AgentInfo {
  id: string;
  name: string;
  /** 'principal' = the built-in assistant (always first, JEFE badge). */
  kind: 'principal' | 'specialist';
  purpose?: string | null;
  /** Index into the 10-color palette (--agent-hue-N). */
  color?: number;
  /** Key into AGENT_ICONS — overrides initials when set. */
  icon?: string;
  status?: AgentStatus;
  /** What it's doing right now ("Investigando precios…"), shown as status-line. */
  statusLine?: string | null;
  unread?: boolean;
  sortOrder?: number;
}

/** Server DTO (src/modules/agents/agent-service.ts `AgentRecord`). */
export interface AgentRecordDTO {
  id: string;
  kind: string;
  name: string;
  purpose: string | null;
  icon: string | null;
  /** Palette index stored as a string ("0".."9"). */
  color: string | null;
  /** 'active' | 'paused' | 'archived'. */
  status: string;
  sortOrder: number;
}

/** Map a persisted Agent to the UI model. Paused/archived → offline. */
export function agentFromRecord(a: AgentRecordDTO): AgentInfo {
  const hue = a.color !== null ? Number.parseInt(a.color, 10) : NaN;
  return {
    id: a.id,
    name: a.name,
    kind: a.kind === 'principal' ? 'principal' : 'specialist',
    purpose: a.purpose,
    color: Number.isFinite(hue) ? hue : undefined,
    icon: a.icon ?? (a.kind === 'principal' ? 'central' : undefined),
    status: a.status === 'paused' || a.status === 'archived' ? 'offline' : 'idle',
    sortOrder: a.sortOrder,
  };
}

/** The assistant itself — always present even without the agents API. */
export const PRINCIPAL_AGENT: AgentInfo = {
  id: 'principal',
  name: 'UNIK Central',
  kind: 'principal',
  purpose: 'Coordina al equipo y responde directo',
  color: 0,
  icon: 'central',
  status: 'idle',
  sortOrder: 0,
};

/** Curated icon set for agent avatars (lucide). */
export const AGENT_ICONS: Record<string, LucideIcon> = {
  central: Brain,
  research: Globe,
  data: ChartColumn,
  msg: Megaphone,
  watch: Eye,
  code: Code,
  sales: HandCoins,
  support: LifeBuoy,
  audit: ShieldCheck,
  library: BookOpenCheck,
  ops: Cpu,
};

export const AGENT_ICON_KEYS = Object.keys(AGENT_ICONS);

/** 10 avatar colors → --agent-hue-N (defined in globals.css, light + dark). */
export const AGENT_HUE_COUNT = 10;

export function agentHue(color?: number): number {
  if (typeof color !== 'number' || Number.isNaN(color)) return 0;
  return ((color % AGENT_HUE_COUNT) + AGENT_HUE_COUNT) % AGENT_HUE_COUNT;
}

/** Initials fallback when the agent has no icon. */
export function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'A';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** "ahora" · "hace 12 min" · "hace 3 h" · "ayer" · "12 feb" */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMin = Math.round((Date.now() - t) / 60_000);
  if (diffMin < 1) return 'ahora';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return 'ayer';
  if (diffD < 7) return `hace ${diffD} d`;
  return new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
