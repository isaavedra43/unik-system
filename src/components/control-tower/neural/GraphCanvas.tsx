'use client';

import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { GraphNode } from './GraphNode';
import type { GraphFlowNode, GraphNodePosition, GraphView } from './graph-model';

/**
 * Lienzo del explorador del grafo (plan 7.8c). SÓLO SE CARGA CON `dynamic()`.
 *
 * React Flow primero, como decidió el ADR-002: hasta ~500 nodos dibujados se
 * comporta bien y nos da arrastre, zoom y teclado sin escribirlos. El recorte a
 * 500 y el aviso de truncado los decide `graph-model.ts`, no este componente.
 *
 * Los nodos SÍ se arrastran: esa posición es lo que se guarda en una escena.
 */

type FlowNode = Node<{ node: GraphFlowNode }, 'graph'>;

function GraphFlowNodeView({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <GraphNode node={data.node} selected={selected === true} onCanvas />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const NODE_TYPES: NodeTypes = { graph: GraphFlowNodeView };

const MINIMAP_NODE_COLOR = 'var(--unik-border)';

export interface GraphCanvasProps {
  view: GraphView;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Doble clic sobre un nodo: cargar sus vecinos directos. */
  onExpand: (key: string) => void;
  /** Se soltó un nodo: la escena recuerda dónde quedó. */
  onMove: (key: string, position: GraphNodePosition) => void;
  label: string;
}

function describeNode(node: GraphFlowNode): string {
  const parts = [`${node.typeLabel}: ${node.label}`];
  if (node.sublabel) parts.push(node.sublabel);
  if (node.root) parts.push('punto de partida');
  if (node.masked.length > 0) parts.push('tiene campos ocultos');
  return parts.join('. ');
}

export default function GraphCanvas({
  view,
  selectedKey,
  onSelect,
  onExpand,
  onMove,
  label,
}: GraphCanvasProps) {
  const incomingNodes = useMemo<FlowNode[]>(
    () =>
      view.nodes.map((node) => ({
        id: node.key,
        type: 'graph',
        position: node.position,
        data: { node },
        selected: node.key === selectedKey,
        ariaLabel: describeNode(node),
      })),
    [view.nodes, selectedKey]
  );

  const incomingEdges = useMemo<Edge[]>(
    () =>
      view.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        labelShowBg: true,
        focusable: false,
      })),
    [view.edges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(incomingNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(incomingEdges);

  useEffect(() => {
    setNodes(incomingNodes);
  }, [incomingNodes, setNodes]);

  useEffect(() => {
    setEdges(incomingEdges);
  }, [incomingEdges, setEdges]);

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      onSelect(node.id === selectedKey ? null : node.id);
    },
    [onSelect, selectedKey]
  );

  const handleNodeDoubleClick = useCallback(
    (_event: unknown, node: Node) => {
      onExpand(node.id);
    },
    [onExpand]
  );

  const handleDragStop = useCallback(
    (_event: unknown, node: Node) => {
      onMove(node.id, { x: node.position.x, y: node.position.y });
    },
    [onMove]
  );

  return (
    <div className="neural-canvas" role="group" aria-label={label}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeDragStop={handleDragStop}
        onPaneClick={() => onSelect(null)}
        fitView
        /* Mismo suelo que el visor de procesos: el encuadre inicial no encoge
           los nodos hasta volver ilegible su etiqueta; se recorre el lienzo. */
        fitViewOptions={{ padding: 0.12, minZoom: 0.6, maxZoom: 1 }}
        minZoom={0.1}
        maxZoom={1.5}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} />
        <Controls showInteractive={false} aria-label="Acercar, alejar y encuadrar la red" />
        {view.nodes.length > 40 ? (
          <MiniMap pannable zoomable nodeColor={MINIMAP_NODE_COLOR} ariaLabel="Mapa de la red" />
        ) : null}
      </ReactFlow>
    </div>
  );
}
