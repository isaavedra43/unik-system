import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import React from 'react';
import '@/styles/shadcn.css';
import '@/app/globals.css';
import '@/styles/universo.css';
import { TooltipProvider } from '@/components/shadcn/tooltip';
import type { UiComponent } from '@/modules/ai/generative-ui/types';
import { Cards } from './Cards';
import { ApprovalCard, MissionCard, PlanCard, TeamRunCard } from './Agentic';
import { ArtifactCard } from './ArtifactCard';
import { Markdown } from '../chat/Markdown';
import { WorkLog } from '../chat/WorkLog';
import { installUniversoMocks, proposalsFixture, tasksFixture } from '../stories/fixtures';

/** Every answer card of UNIVERSO with fixtures (no network, no real data). */
function Frame({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  installUniversoMocks({});
  if (typeof document !== 'undefined')
    document.documentElement.classList.toggle('dark', Boolean(dark));
  return (
    <TooltipProvider>
      <div
        className="uv-scope"
        style={{
          background: 'var(--unik-surface)',
          color: 'var(--unik-text)',
          minHeight: '100dvh',
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 736,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {children}
        </div>
      </div>
    </TooltipProvider>
  );
}

const DATA: UiComponent[] = [
  {
    type: 'kpi',
    title: 'Ventas de ayer',
    items: [
      { label: 'Ventas', value: '$482,300', delta: '+12% vs semana', tone: 'success' },
      { label: 'Pedidos', value: '31', delta: '+4', tone: 'success' },
      { label: 'Atrasados', value: '4', delta: '1 crítico', tone: 'danger' },
    ],
  },
  {
    type: 'table',
    heading: 'Cotizaciones sin respuesta',
    source: 'Zoho Books',
    columns: ['Folio', 'Cliente', 'Monto', 'Estado'],
    rows: [
      ['COT-2291', 'Constructora Norte', '$186,400', 'Enviada'],
      ['COT-2288', 'Hotel Brisas', '$94,150', 'Enviada'],
      ['COT-2275', 'Arq. Paola Ríos', '$38,900', 'Vencida'],
    ],
    total: 3,
  },
  {
    type: 'records',
    heading: 'Resultados de internet',
    source: 'Internet',
    total: 3,
    items: [
      {
        title: 'Lista de precios 2026 — Mármoles del Norte',
        url: 'https://www.marmolesdelnorte.mx/precios',
        body: 'Travertino fiorito desde $689 m²',
      },
      {
        title: 'Travertino al mejor precio | Piedras MX',
        url: 'https://piedrasmx.com/travertino',
        body: 'Promoción de temporada 15%',
      },
      {
        title: 'Mármol y piedra natural | The Home Depot México',
        url: 'https://www.homedepot.com.mx/marmol',
        body: 'Losetas desde $529 m²',
      },
    ],
  },
  {
    type: 'chart',
    title: 'Ventas por semana',
    chart: 'bar',
    unit: '$',
    labels: ['S34', 'S35', 'S36', 'S37', 'S38', 'S39'],
    series: [{ name: 'Ventas', data: [310000, 355000, 298000, 402000, 431000, 482300] }],
  },
  {
    type: 'progress',
    title: 'Recuperar cotizaciones',
    steps: [
      { title: 'Priorizar por monto', status: 'done' },
      { title: 'Redactar seguimiento', status: 'done' },
      { title: 'Enviar con tu aprobación', status: 'running' },
      { title: 'Reportar resultados', status: 'pending' },
    ],
  },
  {
    type: 'notice',
    tone: 'warning',
    title: 'El pedido OV-10482 lleva 15 días',
    detail: 'Falta travertino en Monterrey; el proveedor confirmó llegada el lunes.',
  },
  { type: 'connect', toolkit: 'slack', name: 'Slack', connected: false },
];

const meta: Meta = {
  title: 'Universo/Tarjetas',
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj;

const Everything = ({ dark }: { dark?: boolean }) => (
  <Frame dark={dark}>
    <WorkLog
      reasoning="Traigo ventas y cotizaciones de la base de datos, reviso precios de la competencia en internet y preparo el PDF."
      steps={[
        {
          key: '1',
          name: 'querySalesOrders',
          status: 'done',
          durationMs: 820,
          args: { dateFrom: 'ayer' },
          result: { total: 31 },
        },
        {
          key: '2',
          name: 'web_search',
          status: 'done',
          durationMs: 1840,
          args: { query: 'precio travertino m2 Monterrey' },
        },
        {
          key: '3',
          name: 'browser',
          status: 'done',
          durationMs: 5200,
          args: { action: 'open', url: 'https://www.marmolesdelnorte.mx/precios' },
        },
        {
          key: '4',
          name: 'venueExec',
          status: 'done',
          durationMs: 3100,
          args: { command: 'npm test' },
          result: { exitCode: 0, output: 'Tests: 3 passed' },
        },
        {
          key: '5',
          name: 'sendMessageToContact',
          status: 'pending',
          durationMs: 90,
          args: { contact: 'Constructora Norte' },
        },
      ]}
      elapsedMs={13_200}
    />
    <WorkLog
      live
      reasoning="Comparando precios…"
      steps={[
        {
          key: 'a',
          name: 'browser',
          status: 'running',
          args: { action: 'open', url: 'https://piedrasmx.com' },
        },
      ]}
    />
    <Cards components={DATA} />
    <Markdown
      content={`### Resumen\nEl **travertino** de la competencia está entre **$529 y $689 m²**; el nuestro en **$640 m²**.\n\n- Mantener precio\n- Ofrecer entrega en 10 días\n\n\`\`\`ts\nconst margen = (precio - costo) / precio;\n\`\`\``}
    />
    <ArtifactCard
      artifact={{
        artifactId: 'art-1',
        type: 'pdf',
        title: 'Arranque del día — 26 sep',
        filename: 'arranque.pdf',
        downloadUrl: '/x.pdf',
        sizeBytes: 184320,
        pageCount: 3,
      }}
    />
    <ArtifactCard
      artifact={{
        artifactId: 'art-2',
        type: 'xlsx',
        title: 'Cotizaciones sin respuesta',
        filename: 'cotizaciones.xlsx',
        downloadUrl: '/x.xlsx',
        sizeBytes: 22300,
        rowCount: 12,
      }}
    />
    <ApprovalCard
      proposal={proposalsFixture[0]}
      onDecided={() => undefined}
      onHandoff={() => undefined}
    />
    <PlanCard
      active
      onRun={() => undefined}
      onAdjust={() => undefined}
      plan={{
        goal: 'Recuperar las cotizaciones sin respuesta',
        steps: [
          { n: 1, title: 'Priorizar por monto y fecha', tool: 'queryQuotes' },
          { n: 2, title: 'Redactar un seguimiento por cliente', tool: 'draftReply' },
          { n: 3, title: 'Enviar por WhatsApp', tool: 'sendMessageToContact', needsApproval: true },
        ],
        assumptions: ['Solo cotizaciones de septiembre'],
        deliverable: 'Tabla con respuesta de cada cliente',
      }}
    />
    <MissionCard
      active
      mission={{
        missionId: 'mi-1',
        goal: 'Recuperar 12 cotizaciones',
        steps: [
          { title: 'Priorizar', status: 'done' },
          { title: 'Enviar', status: 'running' },
        ],
        initialStatus: 'done',
      }}
    />
    <TeamRunCard
      tasks={tasksFixture}
      agentName={(id) =>
        id === 'ag-prospector' ? 'Prospector' : id === 'ag-cobranza' ? 'Cobranza' : null
      }
    />
  </Frame>
);

export const Todas: Story = { render: () => <Everything /> };
export const TodasOscuro: Story = { render: () => <Everything dark /> };
