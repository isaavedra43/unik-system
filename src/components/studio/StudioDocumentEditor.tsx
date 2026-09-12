'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  History,
  LayoutTemplate,
  Plus,
  Save,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button, FormField, Input, Select, Spinner, Textarea } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/composite';
import {
  BLOCK_TYPE_LABELS,
  formatDateTime,
  newBlock,
  STATUS_LABELS,
  statusBadgeClass,
  studioApi,
  StudioApiError,
  type SaveDocumentResult,
  type StudioBlock,
  type StudioContent,
  type StudioDocumentDetailDTO,
} from './studio-client';
import { StudioBlockEditor } from './StudioBlockEditor';
import { StudioVersionsPanel } from './StudioVersionsPanel';
import { StudioExportMenu } from './StudioExportMenu';
import { StudioAiEditDialog } from './StudioAiEditDialog';

/**
 * Block editor for one document: add/edit/delete/reorder blocks, save (new
 * version), versions, exports, AI edit on the selection, approve/share and
 * "save as template".
 */

interface Props {
  documentId: string;
  canApprove: boolean;
  currentUserId: string;
  onClose: () => void;
}

const BLOCK_TYPES = Object.keys(BLOCK_TYPE_LABELS) as StudioBlock['type'][];

export function StudioDocumentEditor({ documentId, canApprove, currentUserId, onClose }: Props) {
  const [doc, setDoc] = useState<StudioDocumentDetailDTO | null>(null);
  const [content, setContent] = useState<StudioContent>({ version: 1, blocks: [] });
  const [title, setTitle] = useState('');
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addType, setAddType] = useState<StudioBlock['type']>('paragraph');
  const [panel, setPanel] = useState<'none' | 'versions' | 'exports'>('none');
  const [aiOpen, setAiOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateScope, setTemplateScope] = useState<'personal' | 'team'>('personal');
  const [templateDescription, setTemplateDescription] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const applyDocument = useCallback((next: StudioDocumentDetailDTO) => {
    setDoc(next);
    setContent(next.content);
    setTitle(next.title);
    setSavedSnapshot(JSON.stringify({ title: next.title, content: next.content }));
    setSelected(new Set());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyDocument(await studioApi.getDocument(documentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el documento');
    } finally {
      setLoading(false);
    }
  }, [applyDocument, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => JSON.stringify({ title, content }) !== savedSnapshot,
    [title, content, savedSnapshot]
  );
  const canEdit = doc?.permissions.canEdit ?? false;
  const wasApproved = doc?.status === 'approved' || doc?.status === 'shared';

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function describeSave(result: SaveDocumentResult): string {
    const parts: string[] = [];
    parts.push(
      result.versionCreated
        ? `Versión ${result.version} guardada`
        : 'Guardado (sin cambios de contenido)'
    );
    if (result.diff?.summary && result.versionCreated)
      parts.push(result.diff.summary.toLowerCase());
    if (result.revertedToDraft) {
      parts.push(
        `el documento volvió a borrador${result.invalidatedProposals > 0 ? ` y se invalidaron ${result.invalidatedProposals} propuesta(s) pendiente(s)` : ''}`
      );
    }
    return parts.join(' · ');
  }

  async function save() {
    if (!doc || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const contentChanged = JSON.stringify(content) !== JSON.stringify(doc.content);
      const result = await studioApi.saveDocument(doc.id, {
        ...(title !== doc.title ? { title } : {}),
        ...(contentChanged ? { content } : {}),
      });
      applyDocument(result.document);
      setNotice(describeSave(result));
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  function updateBlock(id: string, next: StudioBlock) {
    setContent((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === id ? next : b)) }));
  }
  function removeBlock(id: string) {
    setContent((c) => ({ ...c, blocks: c.blocks.filter((b) => b.id !== id) }));
    setSelected((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
  function moveBlock(id: string, delta: -1 | 1) {
    setContent((c) => {
      const index = c.blocks.findIndex((b) => b.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= c.blocks.length) return c;
      const blocks = [...c.blocks];
      const [block] = blocks.splice(index, 1);
      blocks.splice(target, 0, block);
      return { ...c, blocks };
    });
  }
  function addBlock(afterId?: string) {
    const block = newBlock(addType);
    setContent((c) => {
      const blocks = [...c.blocks];
      const index = afterId ? blocks.findIndex((b) => b.id === afterId) : -1;
      blocks.splice(index >= 0 ? index + 1 : blocks.length, 0, block);
      return { ...c, blocks };
    });
  }
  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAction(
    name: string,
    fn: () => Promise<StudioDocumentDetailDTO>,
    okMessage: string
  ) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      applyDocument(await fn());
      setNotice(okMessage);
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'La acción falló');
    } finally {
      setBusy(null);
    }
  }

  async function saveAsTemplate() {
    if (!doc) return;
    setBusy('template');
    setError(null);
    try {
      await studioApi.createTemplate({
        name: templateName.trim() || doc.title,
        description: templateDescription.trim() || undefined,
        kind: doc.kind,
        scope: templateScope,
        content,
      });
      setTemplateOpen(false);
      setNotice(`Plantilla "${templateName.trim() || doc.title}" guardada`);
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'No se pudo guardar la plantilla');
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (!doc || !window.confirm(`¿Archivar "${doc.title}"?`)) return;
    setBusy('archive');
    try {
      await studioApi.archiveDocument(doc.id);
      onClose();
    } catch (err) {
      setError(err instanceof StudioApiError ? err.message : 'No se pudo archivar');
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="assistant-admin-loading">
        <Spinner /> Cargando documento…
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="assistant-admin-panel">
        <div className="assistant-admin-error" role="alert">
          {error ?? 'Documento no disponible'}
        </div>
        <Button variant="secondary" icon={<ArrowLeft size={16} />} onClick={onClose}>
          Volver
        </Button>
      </div>
    );
  }

  return (
    <div className="assistant-admin-panel">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={16} />}
          onClick={() => {
            if (dirty && !window.confirm('Tienes cambios sin guardar. ¿Salir de todos modos?'))
              return;
            onClose();
          }}
        >
          Documentos
        </Button>
        <Input
          aria-label="Título del documento"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!canEdit}
          maxLength={200}
          style={{ flex: '1 1 240px', fontWeight: 600 }}
        />
        <span className={statusBadgeClass(doc.status)}>
          {STATUS_LABELS[doc.status] ?? doc.status}
        </span>
        <span className="text-muted text-small">
          v{doc.currentVersion ?? '—'} · {formatDateTime(doc.updatedAt)}
          {doc.visibility === 'team' ? ' · equipo' : ''}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <Button
          size="sm"
          icon={<Save size={16} />}
          onClick={save}
          disabled={!dirty || !canEdit}
          isLoading={saving}
        >
          Guardar versión
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Sparkles size={16} />}
          disabled={!canEdit || selected.size === 0 || dirty}
          title={
            dirty
              ? 'Guarda antes de pedir cambios a la IA'
              : selected.size === 0
                ? 'Selecciona uno o más bloques'
                : undefined
          }
          onClick={() => setAiOpen(true)}
        >
          Pedir cambio a la IA ({selected.size})
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<History size={16} />}
          onClick={() => setPanel('versions')}
        >
          Versiones ({doc.versionCount})
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={16} />}
          onClick={() => setPanel('exports')}
        >
          Exportar
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<LayoutTemplate size={16} />}
          onClick={() => setTemplateOpen(true)}
        >
          Guardar como plantilla
        </Button>
        {doc.permissions.canApprove ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<CheckCircle2 size={16} />}
              disabled={dirty || doc.approvedVersionId === doc.currentVersionId}
              isLoading={busy === 'approve'}
              onClick={() =>
                runAction('approve', () => studioApi.approveDocument(doc.id), 'Versión aprobada')
              }
            >
              Aprobar versión
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Share2 size={16} />}
              disabled={
                dirty || doc.status === 'shared' || doc.approvedVersionId !== doc.currentVersionId
              }
              isLoading={busy === 'share'}
              onClick={() =>
                runAction(
                  'share',
                  () => studioApi.shareDocument(doc.id),
                  'Documento compartido con el equipo'
                )
              }
            >
              Compartir con el equipo
            </Button>
          </>
        ) : null}
        {doc.permissions.isOwner || canApprove ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={16} />}
            isLoading={busy === 'archive'}
            onClick={archive}
            style={{ marginLeft: 'auto' }}
          >
            Archivar
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="assistant-admin-success" role="status">
          {notice}
        </div>
      ) : null}
      {wasApproved && dirty ? (
        <div className="alert alert-warning" role="status">
          Este documento está {STATUS_LABELS[doc.status]?.toLowerCase()}. Al guardar cambios de
          contenido volverá a borrador y las propuestas pendientes ligadas a él se invalidarán.
        </div>
      ) : null}
      {!canEdit ? (
        <div className="alert alert-info">
          Solo lectura: no tienes permiso para editar este documento.
        </div>
      ) : null}

      {content.blocks.length === 0 ? (
        <div className="empty-state">
          <h3 className="empty-state-title">Documento vacío</h3>
          <p>Agrega un primer bloque para empezar.</p>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {content.blocks.map((block, index) => (
          <StudioBlockEditor
            key={block.id}
            block={block}
            index={index}
            total={content.blocks.length}
            documentId={doc.id}
            readOnly={!canEdit}
            selected={selected.has(block.id)}
            onToggleSelected={() => toggleSelected(block.id)}
            onChange={(next) => updateBlock(block.id, next)}
            onRemove={() => removeBlock(block.id)}
            onMove={(delta) => moveBlock(block.id, delta)}
            onAddAfter={() => addBlock(block.id)}
          />
        ))}
      </div>

      {canEdit ? (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            marginTop: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <Select
            aria-label="Tipo de bloque"
            value={addType}
            onChange={(e) => setAddType(e.target.value as StudioBlock['type'])}
            style={{ maxWidth: 220 }}
          >
            {BLOCK_TYPES.map((t) => (
              <option key={t} value={t}>
                {BLOCK_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={16} />}
            onClick={() => addBlock()}
          >
            Agregar bloque
          </Button>
        </div>
      ) : null}

      <StudioVersionsPanel
        open={panel === 'versions'}
        documentId={doc.id}
        canEdit={canEdit}
        onClose={() => setPanel('none')}
        onRestored={(result) => {
          applyDocument(result.document);
          setNotice(describeSave(result));
          setPanel('none');
        }}
      />
      <StudioExportMenu
        open={panel === 'exports'}
        documentId={doc.id}
        dirty={dirty}
        onClose={() => setPanel('none')}
      />
      <StudioAiEditDialog
        open={aiOpen}
        documentId={doc.id}
        blockIds={[...selected]}
        onClose={() => setAiOpen(false)}
        onApplied={(result) => {
          applyDocument(result.document);
          setNotice(`IA aplicada · ${describeSave(result)}`);
          setAiOpen(false);
        }}
      />

      <Modal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title="Guardar como plantilla"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTemplateOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveAsTemplate} isLoading={busy === 'template'}>
              Guardar plantilla
            </Button>
          </>
        }
      >
        <FormField label="Nombre" htmlFor="studio-template-name">
          <Input
            id="studio-template-name"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder={doc.title}
            maxLength={120}
          />
        </FormField>
        <FormField label="Descripción (opcional)" htmlFor="studio-template-desc">
          <Textarea
            id="studio-template-desc"
            value={templateDescription}
            onChange={(e) => setTemplateDescription(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </FormField>
        <FormField
          label="Ámbito"
          htmlFor="studio-template-scope"
          help={
            canApprove ? undefined : 'Las plantillas de equipo requieren el permiso de aprobación.'
          }
        >
          <Select
            id="studio-template-scope"
            value={templateScope}
            onChange={(e) => setTemplateScope(e.target.value as 'personal' | 'team')}
          >
            <option value="personal">Personal</option>
            {canApprove ? <option value="team">Equipo</option> : null}
          </Select>
        </FormField>
        <p className="text-muted text-small">
          Se guardará la estructura actual del editor ({content.blocks.length} bloques), incluidos
          los cambios sin guardar.
        </p>
      </Modal>
      <span className="sr-only">
        {currentUserId === doc.ownerUserId ? 'Eres el propietario' : ''}
      </span>
    </div>
  );
}
