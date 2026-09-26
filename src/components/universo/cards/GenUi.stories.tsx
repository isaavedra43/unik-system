import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import React from 'react';
import '@/styles/shadcn.css';
import '@/app/globals.css';
import '@/styles/universo.css';
import { TooltipProvider } from '@/components/shadcn/tooltip';
import { buildHomeSpec } from '@/modules/ai/genui/home';
import type { GenUiSpec } from '@/modules/ai/genui/catalog';
import { GenUiView } from './GenUi';
import { homeFixture, installUniversoMocks } from '../stories/fixtures';

/**
 * Generative cards (json-render) with fixtures — what an agent composes with
 * renderUi, and the personalized home. Story data is illustrative only.
 */
function Frame({
  children,
  dark,
  width = 736,
}: {
  children: React.ReactNode;
  dark?: boolean;
  width?: number;
}) {
  installUniversoMocks({ venue: 'ready' });
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
            width: '100%',
            maxWidth: width,
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

const REPORT: GenUiSpec = {
  root: 'root',
  elements: {
    root: { type: 'Stack', props: { gap: 'md' }, children: ['kpis', 'tabs'] },
    kpis: { type: 'Grid', props: { columns: 3, gap: 'sm' }, children: ['k1', 'k2', 'k3'] },
    k1: {
      type: 'Metric',
      props: {
        label: 'Ventas',
        value: 482300,
        format: 'money',
        delta: '+12% vs semana',
        trend: 'up',
        icon: 'money',
      },
    },
    k2: {
      type: 'Metric',
      props: { label: 'Pedidos', value: 31, delta: '+4', trend: 'up', icon: 'cart' },
    },
    k3: {
      type: 'Metric',
      props: { label: 'Atrasados', value: 4, delta: '1 crítico', trend: 'down', icon: 'truck' },
    },
    tabs: {
      type: 'Tabs',
      props: {
        tabs: [
          { id: 'chart', label: 'Gráfica' },
          { id: 'table', label: 'Detalle' },
        ],
        value: { $bindState: '/tab' },
      },
      children: ['chart', 'detail'],
    },
    chart: {
      type: 'Chart',
      props: {
        kind: 'bar',
        data: { $state: '/byBranch' },
        xKey: 'branch',
        series: [{ key: 'total', label: 'Ventas' }],
        unit: '$',
      },
      visible: { $state: '/tab', eq: 'chart' },
    },
    detail: {
      type: 'Stack',
      props: { gap: 'sm' },
      visible: { $state: '/tab', eq: 'table' },
      children: ['filter', 'table'],
    },
    filter: {
      type: 'Select',
      props: {
        label: 'Sucursal',
        value: { $bindState: '/branch' },
        options: [
          { value: '', label: 'Todas' },
          { value: 'Norte', label: 'Norte' },
          { value: 'Centro', label: 'Centro' },
        ],
      },
    },
    table: {
      type: 'Table',
      props: {
        columns: [
          { key: 'folio', label: 'Folio' },
          { key: 'cliente', label: 'Cliente' },
          { key: 'branch', label: 'Sucursal' },
          { key: 'total', label: 'Total', format: 'money' },
        ],
        rows: { $state: '/rows' },
        filterKey: 'branch',
        filterValue: { $state: '/branch' },
        searchable: true,
        pageSize: 5,
      },
    },
  },
  state: {
    tab: 'chart',
    branch: '',
    byBranch: [
      { branch: 'Norte', total: 212000 },
      { branch: 'Centro', total: 164300 },
      { branch: 'Sur', total: 106000 },
    ],
    rows: [
      { folio: 'SO-1182', cliente: 'Constructora Monterrey', branch: 'Norte', total: 84200 },
      { folio: 'SO-1183', cliente: 'Grupo Pétreo', branch: 'Centro', total: 51300 },
      { folio: 'SO-1184', cliente: 'Casa Roble', branch: 'Norte', total: 38900 },
      { folio: 'SO-1185', cliente: 'Interiores Lumen', branch: 'Sur', total: 26400 },
      { folio: 'SO-1186', cliente: 'Obra Cumbres', branch: 'Centro', total: 19800 },
      { folio: 'SO-1187', cliente: 'Hotel Sierra', branch: 'Norte', total: 88900 },
    ],
  },
};

const BOARD: GenUiSpec = {
  root: 'board',
  elements: {
    board: {
      type: 'Card',
      props: {
        title: 'Lanzamiento de la línea Travertino',
        subtitle: '9 tareas · 3 en riesgo',
        icon: 'target',
      },
      children: ['progress', 'kanban', 'actions'],
    },
    progress: { type: 'Progress', props: { label: 'Avance general', value: 58, tone: 'info' } },
    kanban: {
      type: 'Kanban',
      props: {
        columns: [
          { id: 'todo', title: 'Por hacer' },
          { id: 'doing', title: 'En curso', tone: 'info' },
          { id: 'risk', title: 'En riesgo', tone: 'warning' },
          { id: 'done', title: 'Hecho', tone: 'success' },
        ],
        items: [
          { id: '1', column: 'todo', title: 'Fotos de producto', meta: 'vie' },
          {
            id: '2',
            column: 'doing',
            title: 'Lista de precios',
            subtitle: 'Cobranza revisa',
            badge: 'Alta',
          },
          {
            id: '3',
            column: 'risk',
            title: 'Proveedor de travertino',
            subtitle: 'Sin confirmar entrega',
          },
          { id: '4', column: 'done', title: 'Landing publicada', meta: 'ayer' },
        ],
      },
    },
    actions: {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 'sm', wrap: true },
      children: ['ask', 'files'],
    },
    ask: {
      type: 'Button',
      props: { label: 'Destrabar lo que está en riesgo', variant: 'primary', icon: 'zap' },
      on: {
        press: { action: 'ask', params: { text: 'Destraba las tareas en riesgo del lanzamiento' } },
      },
    },
    files: {
      type: 'Button',
      props: { label: 'Ver archivos', variant: 'ghost', icon: 'folder' },
      on: { press: { action: 'openWorkspace', params: { tab: 'files' } } },
    },
  },
};

const TOOLS: GenUiSpec = {
  root: 'root',
  elements: {
    root: { type: 'Grid', props: { columns: 2, gap: 'md' }, children: ['pc', 'files', 'routine'] },
    pc: { type: 'ComputerStatus', props: {} },
    files: {
      type: 'Card',
      props: { title: 'Entregables', icon: 'file' },
      children: ['f1', 'f2'],
    },
    f1: {
      type: 'FilePreview',
      props: {
        name: 'Ventas septiembre.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 482113,
        artifactId: 'a-1',
      },
    },
    f2: {
      type: 'FilePreview',
      props: {
        name: 'Cobranza vencida.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 90211,
        artifactId: 'a-2',
      },
    },
    routine: {
      type: 'Card',
      props: { title: 'Nueva rutina', icon: 'repeat' },
      children: ['rb'],
    },
    rb: {
      type: 'RoutineBuilder',
      props: {
        goal: 'Enviar cada mañana el resumen de ventas y cobranza',
        schedule: 'Diario a las 8:00',
        steps: ['Consultar ventas de ayer', 'Revisar cobranza vencida', 'Enviarme el resumen'],
      },
    },
  },
};

const meta: Meta = {
  title: 'Universo/Tarjetas generativas',
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj;

export const Reporte: Story = {
  render: () => (
    <Frame>
      <GenUiView spec={REPORT} title="Ventas de la semana" />
    </Frame>
  ),
};
export const ReporteOscuro: Story = {
  render: () => (
    <Frame dark>
      <GenUiView spec={REPORT} title="Ventas de la semana" />
    </Frame>
  ),
};
export const TableroDeProyecto: Story = {
  render: () => (
    <Frame>
      <GenUiView spec={BOARD} title="Proyecto" />
    </Frame>
  ),
};
export const ComputadoraArchivosRutina: Story = {
  render: () => (
    <Frame>
      <GenUiView spec={TOOLS} title="Tu espacio" />
    </Frame>
  ),
};
export const Inicio: Story = {
  render: () => (
    <Frame>
      <div className="uv-home">
        <GenUiView spec={buildHomeSpec(homeFixture)} bare />
      </div>
    </Frame>
  ),
};
export const InicioOscuroMovil: Story = {
  render: () => (
    <Frame dark width={375}>
      <div className="uv-home">
        <GenUiView spec={buildHomeSpec(homeFixture)} bare />
      </div>
    </Frame>
  ),
};
