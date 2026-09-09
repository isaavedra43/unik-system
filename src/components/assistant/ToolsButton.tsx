'use client';

import { useState, useRef, useEffect } from 'react';
import { Wrench, X, ChevronDown } from 'lucide-react';

interface ToolInfo {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
}

interface ToolCategory {
  id: string;
  label: string;
  tools: ToolInfo[];
}

interface ToolsButtonProps {
  onSelect?: (toolName: string, description: string) => void;
  disabled?: boolean;
}

export function ToolsButton({ onSelect, disabled }: ToolsButtonProps) {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [hoveredTool, setHoveredTool] = useState<ToolInfo | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Fetch tools when opening
  useEffect(() => {
    if (!open || categories.length > 0) return;
    setLoading(true);
    fetch('/app/assistant/api/tools')
      .then((r) => r.json())
      .then((data) => {
        if (data.categories) {
          setCategories(data.categories);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, categories.length]);

  function handleSelect(tool: ToolInfo) {
    if (onSelect) {
      onSelect(tool.name, tool.description);
    }
    setOpen(false);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="assistant-input-attach"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-label="Ver tools disponibles"
        title="Ver tools disponibles del asistente"
      >
        <Wrench size={18} />
      </button>

      {open && (
        <div className="tools-popover-overlay" onClick={() => setOpen(false)}>
          <div
            ref={popoverRef}
            className="tools-popover"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tools-popover-header">
              <h3 className="tools-popover-title">
                <Wrench size={16} />
                Tools del Asistente
              </h3>
              <button
                type="button"
                className="tools-popover-close"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </div>

            <div className="tools-popover-body">
              {loading && (
                <div className="tools-popover-loading">
                  <span className="spinner" />
                  <span>Cargando tools…</span>
                </div>
              )}

              {!loading && categories.length === 0 && (
                <div className="tools-popover-empty">
                  No hay tools disponibles.
                </div>
              )}

              {!loading && categories.length > 0 && (
                <div className="tools-popover-grid">
                  <div className="tools-popover-list">
                    {categories.map((cat) => (
                      <div key={cat.id} className="tools-category">
                        <div className="tools-category-header">
                          {cat.label}
                          <span className="tools-category-count">
                            {cat.tools.length}
                          </span>
                        </div>
                        {cat.tools.map((tool) => (
                          <button
                            key={tool.name}
                            type="button"
                            className={`tool-item ${hoveredTool?.name === tool.name ? 'tool-item-active' : ''}`}
                            onMouseEnter={() => setHoveredTool(tool)}
                            onFocus={() => setHoveredTool(tool)}
                            onClick={() => handleSelect(tool)}
                          >
                            <span className="tool-item-name">{tool.name}</span>
                            <ChevronDown size={12} className="tool-item-chevron" />
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>

                  <div className="tools-popover-detail">
                    {hoveredTool ? (
                      <ToolDetail tool={hoveredTool} />
                    ) : (
                      <div className="tools-detail-empty">
                        Pasa el cursor sobre un tool para ver qué hace y cómo usarlo.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ToolDetail({ tool }: { tool: ToolInfo }) {
  const params = tool.parameters;
  const properties = (params?.properties as Record<string, {
    type?: string;
    description?: string;
    enum?: string[];
    default?: unknown;
  }>) ?? {};
  const requiredList = (params?.required as string[]) ?? [];
  const paramKeys = Object.keys(properties);

  return (
    <div className="tools-detail-content">
      <div className="tools-detail-name">{tool.name}</div>
      <div className="tools-detail-description">{tool.description}</div>

      {paramKeys.length > 0 && (
        <div className="tools-detail-params">
          <div className="tools-detail-params-title">
            Parámetros {paramKeys.length > 0 && `(${paramKeys.length})`}
          </div>
          {paramKeys.map((key) => {
            const prop = properties[key];
            const isRequired = requiredList.includes(key);
            const hasDefault = prop?.default !== undefined;
            return (
              <div key={key} className="tools-detail-param">
                <div className="tools-detail-param-header">
                  <span className="tools-detail-param-name">{key}</span>
                  {isRequired && !hasDefault && (
                    <span className="tools-detail-param-required">requerido</span>
                  )}
                  {hasDefault && (
                    <span className="tools-detail-param-default">
                      default: {String(prop.default)}
                    </span>
                  )}
                  {prop?.type && (
                    <span className="tools-detail-param-type">{prop.type}</span>
                  )}
                </div>
                {prop?.description && (
                  <div className="tools-detail-param-desc">{prop.description}</div>
                )}
                {prop?.enum && prop.enum.length > 0 && (
                  <div className="tools-detail-param-enum">
                    {prop.enum.map((v) => (
                      <span key={v} className="tools-detail-enum-value">{v}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {paramKeys.length === 0 && (
        <div className="tools-detail-params">
          <div className="tools-detail-params-title">Parámetros</div>
          <div className="tools-detail-param-desc">Sin parámetros.</div>
        </div>
      )}
    </div>
  );
}
