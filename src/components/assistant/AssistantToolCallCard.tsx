'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';

export interface ToolCallData {
  name: string;
  args: unknown;
  result?: unknown;
  success: boolean;
  durationMs: number;
  errorCode?: string | null;
}

export function AssistantToolCallCard({ data }: { data: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`assistant-tool-card ${data.success ? '' : 'assistant-tool-card-error'}`}>
      <button
        type="button"
        className="assistant-tool-card-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} />
        <span className="assistant-tool-card-name">{data.name}</span>
        <span className={`assistant-tool-card-badge ${data.success ? 'success' : 'error'}`}>
          {data.success ? 'OK' : 'Error'}
        </span>
        <span className="assistant-tool-card-duration">{data.durationMs}ms</span>
      </button>
      {expanded && (
        <div className="assistant-tool-card-body">
          <div className="assistant-tool-card-section">
            <span className="assistant-tool-card-label">Args:</span>
            <pre>{JSON.stringify(data.args, null, 2)}</pre>
          </div>
          {data.result !== undefined && (
            <div className="assistant-tool-card-section">
              <span className="assistant-tool-card-label">Resultado:</span>
              <pre>{JSON.stringify(data.result, null, 2)}</pre>
            </div>
          )}
          {data.errorCode && (
            <div className="assistant-tool-card-section">
              <span className="assistant-tool-card-label">Error:</span>
              <pre>{data.errorCode}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
