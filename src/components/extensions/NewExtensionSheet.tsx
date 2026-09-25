'use client';

import React from 'react';
import { Braces, Globe, Loader2, Plug } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/shadcn/sheet';

export interface ExtensionForm {
  kind: string;
  namespace: string;
  name: string;
  description: string;
  allowedHosts: string;
  allowedRoleKeys: string;
  url: string;
  apiKeyHeader: string;
}

const KINDS = [
  {
    kind: 'mcp',
    title: 'Servidor MCP',
    desc: 'Herramientas remotas por HTTPS (Model Context Protocol). Se sincronizan solas.',
    icon: Globe,
  },
  {
    kind: 'api',
    title: 'API REST',
    desc: 'Operaciones de una API externa. Puedes importar su OpenAPI 3.x después.',
    icon: Braces,
  },
  {
    kind: 'plugin',
    title: 'Plugin',
    desc: 'Paquete .zip con manifest, skills declarativas, operaciones y plantillas.',
    icon: Plug,
  },
] as const;

/**
 * "Nueva extensión" drawer. Creates a DRAFT — nothing runs until it goes
 * through review, approval and enablement.
 */
export function NewExtensionSheet({
  open,
  onOpenChange,
  form,
  setForm,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ExtensionForm;
  setForm: (f: ExtensionForm) => void;
  busy: boolean;
  onCreate: (kind: string) => void;
}) {
  const needsUrl = form.kind !== 'plugin';
  const canSubmit = Boolean(form.namespace.trim() && form.name.trim()) && !busy;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Nueva extensión</SheetTitle>
          <SheetDescription>
            Nace en borrador: nada se ejecuta hasta pasar revisión, aprobación y habilitación.
          </SheetDescription>
        </SheetHeader>

        <div className="ext-kind-grid" role="radiogroup" aria-label="Tipo de extensión">
          {KINDS.map((k) => {
            const Icon = k.icon;
            const active = form.kind === k.kind;
            return (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={active}
                className={`ext-kind-card ${active ? 'active' : ''}`}
                onClick={() => setForm({ ...form, kind: k.kind })}
              >
                <span className="ext-kind-icon">
                  <Icon size={18} />
                </span>
                <span className="ext-kind-title">{k.title}</span>
                <span className="ext-kind-desc">{k.desc}</span>
              </button>
            );
          })}
        </div>

        <div className="assistant-admin-config-grid ext-sheet-grid">
          <div className="assistant-admin-config-field">
            <label htmlFor="ext-ns">Namespace único</label>
            <input
              id="ext-ns"
              value={form.namespace}
              onChange={(e) => setForm({ ...form, namespace: e.target.value })}
              placeholder="mcp.miproveedor"
              autoFocus
            />
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="ext-name">Nombre</label>
            <input
              id="ext-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Mi proveedor"
            />
          </div>
          {needsUrl && (
            <div className="assistant-admin-config-field ext-span-2">
              <label htmlFor="ext-url">
                {form.kind === 'mcp'
                  ? 'URL del servidor MCP (HTTPS)'
                  : 'URL base de la API (HTTPS)'}
              </label>
              <input
                id="ext-url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://"
                inputMode="url"
              />
            </div>
          )}
          <div className="assistant-admin-config-field ext-span-2">
            <label htmlFor="ext-desc">Descripción (opcional)</label>
            <input
              id="ext-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Qué hace esta integración"
            />
          </div>
          <div className="assistant-admin-config-field ext-span-2">
            <label htmlFor="ext-hosts">Dominios aprobados (separados por coma)</label>
            <input
              id="ext-hosts"
              value={form.allowedHosts}
              onChange={(e) => setForm({ ...form, allowedHosts: e.target.value })}
              placeholder="api.proveedor.com, *.proveedor.com"
            />
            <p className="assistant-admin-config-hint">
              Anti-SSRF: solo se permite salir a estos dominios.
            </p>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="ext-roles">Roles autorizados (claves, coma)</label>
            <input
              id="ext-roles"
              value={form.allowedRoleKeys}
              onChange={(e) => setForm({ ...form, allowedRoleKeys: e.target.value })}
              placeholder="ventas, super_admin"
            />
            <p className="assistant-admin-config-hint">Vacío = solo super administradores.</p>
          </div>
          {form.kind !== 'mcp' && (
            <div className="assistant-admin-config-field">
              <label htmlFor="ext-hdr">Header de API key</label>
              <input
                id="ext-hdr"
                value={form.apiKeyHeader}
                onChange={(e) => setForm({ ...form, apiKeyHeader: e.target.value })}
                placeholder="X-API-Key"
              />
            </div>
          )}
        </div>

        <SheetFooter>
          <button
            type="button"
            className="assistant-admin-save-btn"
            disabled={!canSubmit}
            onClick={() => onCreate(form.kind)}
          >
            {busy ? <Loader2 size={16} className="copilot-spin" /> : <Plug size={16} />}
            Crear borrador
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
