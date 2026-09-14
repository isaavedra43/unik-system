'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, Database, Loader2, Plug, Server, Sparkles, Webhook } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui';
import { api, errorMessage, formatDate, type ConnectionRow } from './knowledge-api';

const GROUPS: Array<{ kind: string; title: string; description: string; icon: typeof Server }> = [
  { kind: 'mcp', title: 'Servidores MCP', description: 'Herramientas remotas que la IA puede consultar.', icon: Server },
  { kind: 'api', title: 'APIs', description: 'Servicios externos importados (OpenAPI).', icon: Webhook },
  { kind: 'plugin', title: 'Plugins', description: 'Paquetes de herramientas instalados.', icon: Plug },
  { kind: 'skill', title: 'Skills', description: 'Procedimientos guiados que la IA ejecuta.', icon: Sparkles },
];

const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  enabled: { label: 'Activa', variant: 'success' },
  approved: { label: 'Aprobada', variant: 'info' },
  testing: { label: 'En prueba', variant: 'warning' },
  pending_approval: { label: 'Por aprobar', variant: 'warning' },
  draft: { label: 'Borrador', variant: 'weak' },
  suspended: { label: 'Suspendida', variant: 'danger' },
  revoked: { label: 'Revocada', variant: 'danger' },
};

export function ConnectionsPanel() {
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ connections: ConnectionRow[] }>('/app/admin/knowledge/api/connections')
      .then((d) => setRows(d.connections))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const active = rows?.filter((r) => r.status === 'enabled').length ?? 0;

  return (
    <div className="klib-stack klib-stack-lg">
      <div className="klib-note klib-note-muted">
        <Database size={16} />
        <div className="klib-note-body">
          La IA responde con tres fuentes: <strong>los datos de UNIK</strong> (siempre en vivo), <strong>la biblioteca aprobada</strong> y <strong>las conexiones activas</strong>. Las conexiones se agregan y aprueban en Extensiones.
        </div>
        <div className="klib-note-actions">
          <Link href="/app/admin/extensions" className="btn btn-secondary btn-sm">
            Administrar conexiones <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <section>
        <h3 className="klib-group-title">Datos de UNIK</h3>
        <div className="klib-conn-grid">
          <article className="klib-card klib-conn">
            <div className="klib-conn-head">
              <span className="klib-kind klib-kind-site" aria-hidden="true">
                <Database size={18} />
              </span>
              <div className="klib-file-text">
                <span className="klib-title">Zoho sincronizado</span>
                <span className="klib-sub">Ventas, compras, inventario, contactos, facturas y pagos</span>
              </div>
            </div>
            <p className="klib-conn-desc">La IA consulta estos datos directamente con sus herramientas del sistema, con los permisos de cada usuario.</p>
            <div className="klib-conn-meta">
              <Badge variant="success">Integrado</Badge>
            </div>
          </article>
        </div>
      </section>

      {error && (
        <div className="klib-note klib-note-danger" role="alert">
          <AlertTriangle size={16} />
          <div className="klib-note-body">{error}</div>
        </div>
      )}

      {!rows && !error && (
        <div className="klib-empty" aria-busy="true">
          <Loader2 size={20} className="klib-spin" />
          <p>Cargando conexiones…</p>
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="klib-card">
          <div className="klib-empty">
            <span className="klib-drop-icon" aria-hidden="true">
              <Plug size={22} />
            </span>
            <p className="klib-empty-title">Aún no hay conexiones externas</p>
            <p>Conecta un servidor MCP, importa una API o instala un plugin para que la IA consulte otros sistemas de tu empresa.</p>
            <Link href="/app/admin/extensions" className="btn btn-primary btn-md">
              Conectar MCP, API o plugin
            </Link>
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          <p className="klib-foot">
            {active} de {rows.length} conexiones activas. Solo las activas están disponibles para la IA.
          </p>
          {GROUPS.map((group) => {
            const items = rows.filter((r) => r.kind === group.kind);
            if (items.length === 0) return null;
            const Icon = group.icon;
            return (
              <section key={group.kind}>
                <h3 className="klib-group-title">
                  {group.title} · {items.length}
                </h3>
                <div className="klib-conn-grid">
                  {items.map((c) => {
                    const st = STATUS[c.status] ?? { label: c.status, variant: 'weak' as BadgeVariant };
                    return (
                      <article key={c.id} className="klib-card klib-conn">
                        <div className="klib-conn-head">
                          <span className="klib-kind klib-kind-link" aria-hidden="true">
                            <Icon size={18} />
                          </span>
                          <div className="klib-file-text">
                            <span className="klib-title">{c.name}</span>
                            <span className="klib-sub">{c.namespace}</span>
                          </div>
                        </div>
                        <p className="klib-conn-desc">{c.description || group.description}</p>
                        <div className="klib-conn-meta">
                          <Badge variant={st.variant}>{st.label}</Badge>
                          <span>{c.capabilities} herramientas</span>
                          <span>{c.accounts} cuentas</span>
                          <span>{formatDate(c.updatedAt)}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
