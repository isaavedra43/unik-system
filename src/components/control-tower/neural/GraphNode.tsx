import { EyeOff, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GraphFlowNode } from './graph-model';

export interface GraphNodeProps {
  node: GraphFlowNode;
  selected?: boolean;
  /** Lo dibuja el lienzo (ancho fijo); en la lista se adapta al contenedor. */
  onCanvas?: boolean;
  className?: string;
}

/**
 * Un nodo de la red operativa (plan 7.8c): tipo, etiqueta y detalle, con el
 * color de su área. Marca las raíces de la consulta y dice cuándo trae campos
 * ocultos, para que nadie confunda "sin dato" con "no puedes verlo".
 *
 * Presentacional y sin React Flow: lo usa el lienzo y la lista de móvil.
 */
export function GraphNode({ node, selected = false, onCanvas = false, className }: GraphNodeProps) {
  return (
    <span
      className={cn(
        'neural-graph-node',
        `neural-area-${node.tone}`,
        node.root && 'neural-graph-node-root',
        selected && 'neural-graph-node-selected',
        className
      )}
      style={onCanvas ? { width: '13rem' } : undefined}
    >
      <span className="neural-graph-node-type">{node.typeLabel}</span>
      <span className="neural-graph-node-label" title={node.label}>
        {node.label}
      </span>
      {node.sublabel ? (
        <span className="neural-graph-node-sub" title={node.sublabel}>
          {node.sublabel}
        </span>
      ) : null}
      {(node.root || node.masked.length > 0 || node.status) && (
        <span className="neural-graph-node-flags">
          {node.root ? (
            <>
              <Target className="h-3 w-3" aria-hidden="true" />
              <span>Punto de partida</span>
            </>
          ) : null}
          {node.status ? <span>{node.status}</span> : null}
          {node.masked.length > 0 ? (
            <>
              <EyeOff className="h-3 w-3" aria-hidden="true" />
              <span>Con datos ocultos</span>
            </>
          ) : null}
        </span>
      )}
    </span>
  );
}
