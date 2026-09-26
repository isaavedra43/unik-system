import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  Bot,
  Brain,
  CalendarClock,
  Database,
  FileText,
  Globe,
  Image as ImageIcon,
  Mail,
  Monitor,
  MousePointer2,
  Plug,
  Rocket,
  Search,
  Sparkles,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import { toolLabel, toolStepLabel } from '@/components/copilot/copilot-types';

/**
 * Tool → how the UI shows it in the activity timeline: an icon by category
 * and a human step label ("Buscando en internet: arena para gato").
 */

export type ToolCategory =
  | 'web'
  | 'browser'
  | 'computer'
  | 'terminal'
  | 'data'
  | 'docs'
  | 'media'
  | 'team'
  | 'apps'
  | 'memory'
  | 'messaging'
  | 'sites'
  | 'plan'
  | 'other';

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  web: Globe,
  browser: MousePointer2,
  computer: Monitor,
  terminal: Terminal,
  data: Database,
  docs: FileText,
  media: ImageIcon,
  team: Users,
  apps: Plug,
  memory: Brain,
  messaging: Mail,
  sites: Rocket,
  plan: CalendarClock,
  other: Wrench,
};

export function toolCategory(name: string): ToolCategory {
  if (/^(web_search|web_research|web_crawl|fetch_url)$/.test(name)) return 'web';
  if (/^(browser|browserProfile)$/.test(name)) return 'browser';
  if (name === 'venueExec') return 'terminal';
  if (/^(computer|venue\w*|\w*VenuePlaybook\w*)$/.test(name)) return 'computer';
  if (/^(publishSite|listSites|unpublishSite)$/.test(name)) return 'sites';
  if (
    /^(delegateTask|listAgents|proposeMission|listMissions|missionStatus|controlMission)$/.test(
      name
    )
  )
    return 'team';
  if (/^composio/.test(name) || /__/.test(name)) return 'apps';
  if (/^(rememberForUser|listUserMemory|forgetMemory|recallMemory|saveFact)$/.test(name))
    return 'memory';
  if (/^(generateImage|generateVideo|analyzeImage)$/.test(name)) return 'media';
  if (
    /^(generate|compose|listArtifacts|shareArtifact|cleanupArtifacts|renderView|renderUi|renderInteractiveUi|readAttachment)/.test(
      name
    )
  )
    return 'docs';
  if (
    /^(send|draft|schedule|createCommitment|listInbox|getConversationMessages|notify|callContact|startInternalCall)/.test(
      name
    )
  )
    return 'messaging';
  if (/^(proposePlan|loadMoreTools|reviewAnswer|draftAnswer)$/.test(name)) return 'plan';
  if (/^(query|get|search|lookup|list|find|compare|audit|universal|check|extract)/.test(name))
    return 'data';
  return 'other';
}

export function toolIcon(name: string): LucideIcon {
  if (name === 'draftAnswer' || name === 'reviewAnswer') return Sparkles;
  if (name === 'universalSearch') return Search;
  if (name === 'renderInteractiveUi' || name === 'renderUi') return AppWindow;
  if (name === 'delegateTask') return Bot;
  return CATEGORY_ICON[toolCategory(name)];
}

export function stepLabel(name: string, args: unknown, running: boolean): string {
  if (name === 'computer') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      action?: string;
      command?: string;
      text?: string;
    };
    const verb: Record<string, string> = {
      screenshot: 'Mirando la pantalla',
      click: 'Haciendo clic',
      doubleClick: 'Doble clic',
      rightClick: 'Clic derecho',
      type: 'Escribiendo',
      key: 'Presionando tecla',
      hotkey: 'Atajo de teclado',
      openApp: 'Abriendo app',
      scroll: 'Desplazando',
      windows: 'Revisando ventanas',
      find: 'Buscando en pantalla',
      wait: 'Esperando',
    };
    const base =
      verb[a.action ?? ''] ?? (running ? 'Usando la computadora' : 'Acción en la computadora');
    const extra = a.command ?? (a.text ? `"${a.text.slice(0, 40)}"` : '');
    return extra ? `${base}: ${extra}` : base;
  }
  if (name === 'browser') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      action?: string;
      url?: string;
      ref?: number;
      target?: string;
      text?: string;
    };
    const verb: Record<string, string> = {
      open: 'Abriendo',
      newTab: 'Nueva pestaña',
      snapshot: 'Leyendo la página',
      click: 'Clic',
      type: 'Escribiendo',
      select: 'Eligiendo opción',
      press: 'Tecla',
      scroll: 'Desplazando',
      extract: 'Extrayendo contenido',
      screenshot: 'Mirando la pantalla',
      console: 'Revisando errores de la página',
      evaluate: 'Probando con JavaScript',
      back: 'Atrás',
      forward: 'Adelante',
      reload: 'Recargando',
      submit: 'Enviando formulario',
      secureInput: 'Pidiendo datos seguros',
      pdf: 'Guardando PDF',
      tabs: 'Revisando pestañas',
      switchTab: 'Cambiando de pestaña',
      closeTab: 'Cerrando pestaña',
      waitFor: 'Esperando la página',
      upload: 'Subiendo archivo',
      hover: 'Pasando el cursor',
    };
    const base = verb[a.action ?? ''] ?? toolLabel(name, running ? 'running' : 'done');
    let target = '';
    if (a.url) {
      try {
        target = new URL(a.url.startsWith('http') ? a.url : `https://${a.url}`).hostname.replace(
          /^www\./,
          ''
        );
      } catch {
        target = a.url.slice(0, 50);
      }
    } else if (a.target) target = `«${a.target.slice(0, 40)}»`;
    else if (typeof a.ref === 'number') target = `elemento ${a.ref}`;
    return target ? `${base}: ${target}` : base;
  }
  if (name === 'venueExec') {
    const a = (args && typeof args === 'object' ? args : {}) as { command?: string };
    return a.command
      ? `${running ? 'Ejecutando' : 'Ejecutó'}: ${a.command.slice(0, 80)}`
      : toolLabel(name, running ? 'running' : 'done');
  }
  if (name === 'delegateTask') {
    const a = (args && typeof args === 'object' ? args : {}) as { goal?: string };
    return a.goal
      ? `Delegó: ${a.goal.slice(0, 90)}`
      : toolLabel(name, running ? 'running' : 'done');
  }
  return toolStepLabel(name, args, running ? 'running' : 'done');
}

/** Tools that never appear as steps (the UI shows their result elsewhere). */
export const HIDDEN_STEP_TOOLS = new Set(['proposePlan', 'proposeMission']);
