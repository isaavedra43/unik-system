'use client';

import { useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { StepNode } from './StepNode';
import { describeStep, type ProcessGraphView, type ProcessStepView } from './process-model';

/**
 * Lienzo del visor de procesos (plan 7.8a). SÓLO SE CARGA CON `dynamic()` desde
 * `ProcessViewer`, para que React Flow no entre al bundle de ninguna otra ruta.
 *
 * El acomodo NO lo calcula React Flow: viene de `process-layout.ts` (capas por
 * camino más largo + baricentro), así que el mismo proceso siempre se dibuja
 * igual y el servidor puede precalcularlo.
 *
 * Sólo lectura: los nodos no se arrastran ni se conectan. Sí se recorren con el
 * tabulador y se activan con Enter (React Flow los hace focusables).
 */

type StepFlowNode = Node<{ step: ProcessStepView; label: string }, 'step'>;

function StepFlowNodeView({ data, selected }: NodeProps<StepFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <StepNode step={data.step} onCanvas selected={selected === true} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const NODE_TYPES: NodeTypes = { step: StepFlowNodeView };

/**
 * Suelo del encuadre inicial: por debajo de este zoom el nombre del paso y sus
 * insignias (p50 / p90 / % incumple) dejan de leerse a simple vista.
 */
const MIN_READABLE_ZOOM = 0.6;

/** Aire del lienzo (borde, controles y atribución de React Flow). */
const CANVAS_CHROME = 96;

export interface ProcessCanvasProps {
  view: ProcessGraphView;
  selectedStepKey?: string | null;
  onSelectStep?: (stepKey: string | null) => void;
  /** Nombre accesible del lienzo. */
  label: string;
}

export default function ProcessCanvas({
  view,
  selectedStepKey = null,
  onSelectStep,
  label,
}: ProcessCanvasProps) {
  const nodes = useMemo<StepFlowNode[]>(
    () =>
      view.steps.map((step) => ({
        id: step.key,
        type: 'step',
        position: { x: step.x, y: step.y },
        data: { step, label: describeStep(step) },
        selected: step.key === selectedStepKey,
        draggable: false,
        connectable: false,
        ariaLabel: describeStep(step),
      })),
    [view.steps, selectedStepKey]
  );

  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        className: edge.onPath ? 'neural-edge-path' : edge.dimmed ? 'neural-edge-dim' : undefined,
        animated: false,
        focusable: false,
      })),
    [view.edges]
  );

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (!onSelectStep) return;
      onSelectStep(node.id === selectedStepKey ? null : node.id);
    },
    [onSelectStep, selectedStepKey]
  );

  return (
    <div
      className="neural-canvas"
      role="group"
      aria-label={label}
      // El lienzo se ajusta al alto real del grafo (con tope) en vez de dejar
      // media pantalla en blanco arriba y abajo de un proceso de pocas capas.
      style={{ height: `clamp(20rem, ${Math.round(view.height + CANVAS_CHROME)}px, 40rem)` }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        /*
         * El encuadre inicial NO baja de `MIN_READABLE_ZOOM`: con 15 pasos el
         * `fitView` sin suelo dejaba el nombre del paso en ~4 px. Por debajo de
         * ese zoom el lienzo se recorre (rueda y controles) en vez de encoger.
         */
        fitViewOptions={{ padding: 0.12, minZoom: MIN_READABLE_ZOOM, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={Boolean(onSelectStep)}
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} aria-label="Acercar, alejar y encuadrar el proceso" />
      </ReactFlow>
    </div>
  );
}
