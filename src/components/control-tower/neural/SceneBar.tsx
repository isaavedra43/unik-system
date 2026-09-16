'use client';

import { useState } from 'react';
import { Bookmark, Save, Share2, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/composite';
import { Alert, Button, Checkbox, FormField, Input } from '@/components/ui/primitives';
import type { GraphScene } from '@/modules/control-tower/scenes-service';

export interface SceneBarProps {
  scenes: readonly GraphScene[];
  activeSceneId: string | null;
  /** Hay al menos un punto de partida: sin eso no hay nada que guardar. */
  canSave: boolean;
  busy: boolean;
  error: string | null;
  onOpen: (scene: GraphScene) => void;
  onCreate: (input: { name: string; shared: boolean }) => void;
  onUpdate: (scene: GraphScene) => void;
  onDelete: (scene: GraphScene) => void;
}

/**
 * Escenas guardadas del explorador (plan 7.8c): "cómo quiero volver a ver esta
 * red". Guarda perspectiva, puntos de partida, filtros, posiciones e instante.
 *
 * Una escena COMPARTIDA la abre cualquiera que tenga permiso de la perspectiva,
 * pero sólo su dueño la puede guardar o borrar: eso lo impone el servicio, y la
 * barra sólo muestra los botones que esa persona sí puede usar.
 */
export function SceneBar({
  scenes,
  activeSceneId,
  canSave,
  busy,
  error,
  onOpen,
  onCreate,
  onUpdate,
  onDelete,
}: SceneBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const active = scenes.find((scene) => scene.id === activeSceneId) ?? null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Ponle un nombre a la escena');
      return;
    }
    setNameError(null);
    onCreate({ name: trimmed, shared });
    setDialogOpen(false);
    setName('');
    setShared(false);
  };

  return (
    <div className="neural-panel">
      <div className="neural-panel-head">
        <h3 className="neural-panel-title">
          <Bookmark className="h-4 w-4" aria-hidden="true" /> Escenas guardadas
        </h3>
        <div className="neural-toolbar-actions">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setDialogOpen(true)}
            disabled={!canSave || busy}
            icon={<Save className="h-4 w-4" />}
          >
            Guardar esta vista
          </Button>
          {active && active.canEdit ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onUpdate(active)}
              disabled={busy}
            >
              Actualizar «{active.name}»
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {scenes.length === 0 ? (
        <p className="neural-panel-hint">
          Todavía no hay escenas. Arma una red que te sirva y guárdala: vuelve tal cual, con sus
          filtros, sus posiciones y su instante.
        </p>
      ) : (
        <div className="neural-scenes">
          {scenes.map((scene) => (
            <span
              key={scene.id}
              className={`neural-scene-chip${scene.id === activeSceneId ? ' neural-scene-chip-active' : ''}`}
            >
              <button
                type="button"
                className="neural-row-button neural-scene-chip-name"
                onClick={() => onOpen(scene)}
                disabled={busy}
                title={`${scene.name} · ${scene.perspectiveLabel}${scene.mine ? '' : ` · de ${scene.ownerName ?? 'otra persona'}`}`}
              >
                {scene.name}
              </button>
              {scene.shared ? (
                <Share2 className="h-3 w-3" aria-label="Compartida con el equipo" />
              ) : null}
              {scene.canEdit ? (
                <button
                  type="button"
                  className="neural-row-button"
                  onClick={() => onDelete(scene)}
                  disabled={busy}
                  aria-label={`Borrar la escena ${scene.name}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}

      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Guardar esta vista como escena"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} isLoading={busy}>
              Guardar escena
            </Button>
          </>
        }
      >
        <FormField label="Nombre" htmlFor="neural-scene-name" error={nameError}>
          <Input
            id="neural-scene-name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="Por ejemplo: entregas atoradas por proveedor"
            error={nameError}
          />
        </FormField>
        <Checkbox
          label="Compartir con el equipo"
          description="Quien tenga permiso de esta perspectiva podrá abrirla; sólo tú puedes editarla o borrarla."
          checked={shared}
          onChange={(event) => setShared(event.target.checked)}
        />
        <p className="neural-panel-hint">
          Se guarda la perspectiva, los puntos de partida, los filtros, dónde quedó cada nodo y el
          instante fijado.
        </p>
      </Modal>
    </div>
  );
}
