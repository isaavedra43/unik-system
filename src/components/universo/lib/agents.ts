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
import type { AgentInfo, AgentRecordDTO, WorkspaceTab } from './types';

/** Curated icon set for agent avatars (lucide). Keys are persisted in Agent.icon. */
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

/** 10 avatar colors → --agent-hue-N (globals.css, light + dark). */
export const AGENT_HUE_COUNT = 10;

export function agentHue(color?: number): number {
  if (typeof color !== 'number' || Number.isNaN(color)) return 0;
  return ((color % AGENT_HUE_COUNT) + AGENT_HUE_COUNT) % AGENT_HUE_COUNT;
}

/** The coordinator — always present, even before the agents API answers. */
export const PRINCIPAL_AGENT: AgentInfo = {
  id: 'principal',
  name: 'UNIK Central',
  kind: 'principal',
  purpose: 'Dirige a tu equipo y responde directo',
  color: 0,
  icon: 'central',
  status: 'idle',
  sortOrder: 0,
};

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

/** Tool → workspace surface that should come to the front when it runs. */
export function workspaceTabForTool(tool: string): WorkspaceTab | null {
  if (/^(browser|browserProfile)$/.test(tool)) return 'browser';
  if (/^(web_search|web_research|web_crawl|fetch_url)$/.test(tool)) return 'browser';
  if (/^(computer|venue\w*|runVenuePlaybook|saveVenuePlaybook)$/.test(tool)) return 'computer';
  if (
    /^(generate(Pdf|Excel|Word|Csv)\w*|generateImage|generateVideo|composeDocument|generateChart|generateReportImage|publishSite)$/.test(
      tool
    )
  )
    return 'files';
  if (/^(delegateTask|proposeMission)$/.test(tool)) return 'team';
  return null;
}
