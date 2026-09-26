/**
 * Generative UI for the assistant chat.
 *
 * The chat never renders HTML or components that a model or an external server
 * wrote. Tool results are turned (deterministically, in `build-ui.ts`) into a
 * small closed vocabulary of DATA specs below, and a fixed registry of React
 * components draws them. The single exception is `mcp_ui`: an MCP server's own
 * `ui://` resource, drawn by the official MCP-UI renderer inside a sandboxed
 * iframe with no access to UNIK's origin, cookies or DOM.
 *
 * Pure types + builders: safe to import from server and client.
 */

import type { GenUiSpec } from '../genui/catalog';

export type UiTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface UiField {
  label: string;
  value: string;
}

export interface UiRecord {
  title: string;
  subtitle?: string;
  body?: string;
  /** ISO date/time when parseable, otherwise the raw text. */
  date?: string;
  /** Only http(s) URLs ever reach this field. */
  url?: string;
  badge?: { label: string; tone: UiTone };
  fields?: UiField[];
}

export interface UiMcpResource {
  uri: string;
  mimeType: string;
  text?: string;
}

export interface UiChartSeries {
  name?: string;
  data: number[];
}

export interface UiKpiItem {
  label: string;
  value: string;
  delta?: string;
  tone?: UiTone;
}

export interface UiProgressStep {
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

export interface UiTimelineEvent {
  label: string;
  at?: string;
  detail?: string;
  tone?: UiTone;
}

export interface UiMediaItem {
  kind: 'image' | 'video' | 'audio';
  /** Only http(s) URLs ever reach this field. */
  url: string;
  title?: string;
}

export interface UiCardAction {
  label: string;
  /** Text sent on the user's behalf when the chip is clicked. */
  sendText: string;
}

export type UiComponent =
  | { type: 'connect'; toolkit: string; name: string; connected: boolean }
  | {
      type: 'media';
      source?: string;
      title?: string;
      items: UiMediaItem[];
      /** Interactive follow-ups: variations, format changes, image→video. */
      actions?: UiCardAction[];
    }
  | { type: 'records'; heading?: string; source?: string; items: UiRecord[]; total: number }
  | { type: 'record'; source?: string; record: UiRecord }
  | {
      type: 'table';
      heading?: string;
      source?: string;
      columns: string[];
      rows: string[][];
      total: number;
    }
  | { type: 'notice'; tone: UiTone; title: string; detail?: string; url?: string }
  | {
      /** Live chart spec emitted by the renderView tool — never raw markup. */
      type: 'chart';
      title?: string;
      chart: 'bar' | 'line' | 'pie';
      unit?: string;
      labels: string[];
      series: UiChartSeries[];
    }
  | { type: 'kpi'; title?: string; items: UiKpiItem[] }
  | { type: 'progress'; title: string; steps: UiProgressStep[] }
  | { type: 'timeline'; title?: string; events: UiTimelineEvent[] }
  | { type: 'mcp_ui'; resource: UiMcpResource; title?: string }
  | {
      /** Agent-composed card from the UNIK json-render catalog (renderUi) —
       *  a validated data spec drawn by UNIK's own components. */
      type: 'genui';
      title?: string;
      spec: GenUiSpec;
    }
  | {
      /** Agent-authored interface (renderInteractiveUi) — self-contained
       *  HTML/CSS/JS rendered in a sandboxed iframe, never in the page DOM. */
      type: 'interactive';
      title?: string;
      html: string;
      css?: string;
      js?: string;
      height?: number | null;
    };

export interface UiToolResultInput {
  toolName: string;
  args?: unknown;
  result: unknown;
  success: boolean;
}

export const MAX_UI_COMPONENTS_PER_TOOL = 3;
export const MAX_UI_ITEMS = 12;
