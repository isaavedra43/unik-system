'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FilePlus2, LayoutTemplate, RefreshCw, Trash2, Users, FolderOpen } from 'lucide-react';
import { Button, FormField, Input, Select, Spinner } from '@/components/ui/primitives';
import { EmptyState, Modal } from '@/components/ui/composite';
import {
  formatDateTime,
  STATUS_LABELS,
  statusBadgeClass,
  studioApi,
  StudioApiError,
  type StudioDocumentSummaryDTO,
  type StudioTemplateDTO,
} from './studio-client';
import { StudioDocumentEditor } from './StudioDocumentEditor';

/**
 * Studio entry: "Mis documentos" / "Equipo" / "Plantillas" lists and the
 * document editor. Everything is authorized server-side; the UI only hides
 * actions the API would reject anyway.
 */

type TabId = 'mine' | 'team' | 'templates';

const KIND_LABELS: Record<string, string> = {
  document: 'Documento',
  spreadsheet: 'Hoja de cálculo',
  presentation: 'Presentación',
  image: 'Imagen',
};

export function StudioWorkspace({
  canApprove,
  currentUserId,
}: {
  canApprove: boolean;
  currentUserId: string;
}) {
  const [tab, setTab] = useState<TabId>('mine');
  const [documents, setDocuments] = useState<StudioDocumentSummaryDTO[]>([]);
  const [templates, setTemplates] = useState<StudioTemplateDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('document');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'templates') {
        setTemplates(await studioApi.listTemplates());
      } else {
        setDocuments(await studioApi.listDocuments(tab));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (!openId) void load();
  }, [load, openId]);

  useEffect(() => {
    // Templates are needed by the create dialog even outside the templates tab.
    if (createOpen)
      studioApi
        .listTemplates()
        .then(setTemplates)
        .catch(() => undefined);
  }, [createOpen]);

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const doc = await studioApi.createDocument({
        title: title.trim() || 'Documento sin título',
        kind,
        ...(createTemplateId ? { templateId: createTemplateId } : {}),
      });
      setCreateOpen(false);
      setTitle('');
      setCreateTemplateId('');
      setOpenId(doc.id);
    } catch (err) {
      setCreateError(err instanceof StudioApiError ? err.message : 'No se pudo crear el documento');
    } finally {
      setCreating(false);
    }
  }

  async function archive(doc: StudioDocumentSummaryDTO) {
    if (!window.confirm(`¿Archivar "${doc.title}"? Las versiones y exportaciones se conservan.`))
      return;
    try {
      await studioApi.archiveDocument(doc.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo archivar');
    }
  }

  async function removeTemplate(template: StudioTemplateDTO) {
    if (!window.confirm(`¿Eliminar la plantilla "${template.name}"?`)) return;
    try {
      await studioApi.deleteTemplate(template.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar la plantilla');
    }
  }

  if (openId) {
    return (
      <StudioDocumentEditor
        documentId={openId}
        canApprove={canApprove}
        currentUserId={currentUserId}
        onClose={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="assistant-admin-panel">
      <div className="assistant-admin-tabs" role="tablist">
        {(
          [
            { id: 'mine', label: 'Mis documentos' },
            { id: 'team', label: 'Equipo' },
            { id: 'templates', label: 'Plantillas' },
          ] as Array<{ id: TabId; label: string }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`assistant-admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={16} />}
            onClick={() => load()}
            aria-label="Actualizar"
          >
            Actualizar
          </Button>
          <Button size="sm" icon={<FilePlus2 size={16} />} onClick={() => setCreateOpen(true)}>
            Nuevo documento
          </Button>
        </div>
      </div>

      {error ? (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="assistant-admin-tab-content">
        {loading ? (
          <div className="assistant-admin-loading">
            <Spinner /> Cargando…
          </div>
        ) : tab === 'templates' ? (
          templates.length === 0 ? (
            <EmptyState
              icon="layers"
              title="Sin plantillas"
              message="Guarda un documento como plantilla desde el editor para reutilizar su estructura."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Plantilla</th>
                    <th>Ámbito</th>
                    <th>Bloques</th>
                    <th>Autor</th>
                    <th>Actualizada</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.name}</strong>
                        {t.description ? (
                          <div className="text-muted text-small">{t.description}</div>
                        ) : null}
                      </td>
                      <td>
                        <span
                          className={t.scope === 'team' ? 'badge badge-info' : 'badge badge-weak'}
                        >
                          {t.scope === 'team' ? 'Equipo' : 'Personal'}
                        </span>
                      </td>
                      <td>{t.blockCount}</td>
                      <td>{t.ownerName ?? '—'}</td>
                      <td>{formatDateTime(t.updatedAt)}</td>
                      <td>
                        <div className="row-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<LayoutTemplate size={14} />}
                            onClick={() => {
                              setCreateTemplateId(t.id);
                              setTitle(t.name);
                              setKind(t.kind);
                              setCreateOpen(true);
                            }}
                          >
                            Usar
                          </Button>
                          {t.ownerUserId === currentUserId || (t.scope === 'team' && canApprove) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Trash2 size={14} />}
                              onClick={() => removeTemplate(t)}
                              aria-label={`Eliminar ${t.name}`}
                            >
                              Eliminar
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : documents.length === 0 ? (
          <EmptyState
            icon="fileText"
            title={tab === 'mine' ? 'Aún no tienes documentos' : 'Nada compartido con el equipo'}
            message={
              tab === 'mine'
                ? 'Crea un documento en blanco o desde una plantilla; también puedes pedirle al asistente que convierta un reporte en documento.'
                : 'Los documentos aprobados y compartidos por el equipo aparecerán aquí.'
            }
            action={
              tab === 'mine' ? (
                <Button icon={<FilePlus2 size={16} />} onClick={() => setCreateOpen(true)}>
                  Nuevo documento
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Estado</th>
                  <th>Tipo</th>
                  <th>Versión</th>
                  {tab === 'team' ? <th>Propietario</th> : null}
                  <th>Actualizado</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: 0 }}
                        onClick={() => setOpenId(doc.id)}
                      >
                        <strong>{doc.title}</strong>
                      </button>
                      {doc.visibility === 'team' ? (
                        <span className="text-muted text-small" style={{ marginLeft: '0.5rem' }}>
                          <Users size={12} aria-hidden="true" /> equipo
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className={statusBadgeClass(doc.status)}>
                        {STATUS_LABELS[doc.status] ?? doc.status}
                      </span>
                    </td>
                    <td>{KIND_LABELS[doc.kind] ?? doc.kind}</td>
                    <td>{doc.currentVersion ? `v${doc.currentVersion}` : '—'}</td>
                    {tab === 'team' ? <td>{doc.ownerName ?? '—'}</td> : null}
                    <td>{formatDateTime(doc.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<FolderOpen size={14} />}
                          onClick={() => setOpenId(doc.id)}
                        >
                          Abrir
                        </Button>
                        {doc.permissions.isOwner ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 size={14} />}
                            onClick={() => archive(doc)}
                            aria-label={`Archivar ${doc.title}`}
                          >
                            Archivar
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Nuevo documento"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button onClick={create} isLoading={creating}>
              Crear
            </Button>
          </>
        }
      >
        {createError ? (
          <div className="alert alert-error" role="alert">
            {createError}
          </div>
        ) : null}
        <FormField label="Título" htmlFor="studio-new-title">
          <Input
            id="studio-new-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ej. Cierre de ventas septiembre"
            maxLength={200}
            autoFocus
          />
        </FormField>
        <FormField label="Tipo" htmlFor="studio-new-kind">
          <Select id="studio-new-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Plantilla (opcional)" htmlFor="studio-new-template">
          <Select
            id="studio-new-template"
            value={createTemplateId}
            onChange={(e) => setCreateTemplateId(e.target.value)}
          >
            <option value="">En blanco</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.scope === 'team' ? 'equipo' : 'personal'})
              </option>
            ))}
          </Select>
        </FormField>
      </Modal>
    </div>
  );
}
