'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { VisualProjectSummary } from '@/modules/visual-studio/visual-contract';

interface Props {
  initialProjects: VisualProjectSummary[];
  canEdit: boolean;
  canGenerate: boolean;
  samConfigured: boolean;
}

export function VisualStudioHome({ initialProjects, canEdit, samConfigured }: Props) {
  const router = useRouter();
  const [projects] = useState(initialProjects);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/app/visual-studio/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al crear');
      router.push(`/app/visual-studio/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear');
      setCreating(false);
    }
  }

  return (
    <div className="vs-home">
      {!samConfigured && (
        <div className="vs-banner">
          El worker de segmentación no está configurado (VISUAL_SAM_URL). Puedes crear proyectos y
          subir fotos, pero las máscaras automáticas requieren el servicio SAM 2.
        </div>
      )}
      {canEdit && (
        <div className="vs-new-project">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="Nombre del proyecto (ej. Cocina — Casa Hernández)"
            className="vs-input"
          />
          <button onClick={create} disabled={creating || !name.trim()} className="vs-btn primary">
            {creating ? 'Creando…' : 'Nuevo proyecto'}
          </button>
        </div>
      )}
      {error && <div className="vs-banner error">{error}</div>}
      <div className="vs-project-grid">
        {projects.map((p) => (
          <button
            key={p.id}
            className="vs-project-card"
            onClick={() => router.push(`/app/visual-studio/${p.id}`)}
          >
            <div className="vs-project-name">{p.name}</div>
            <div className="vs-project-meta">
              {p.contactName && <span>{p.contactName}</span>}
              <span>
                {p.assetCount} foto{p.assetCount === 1 ? '' : 's'} · {p.proposalCount} propuesta
                {p.proposalCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="vs-project-date">
              {new Date(p.updatedAt).toLocaleDateString('es-MX', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </div>
          </button>
        ))}
        {projects.length === 0 && (
          <div className="vs-empty">
            Aún no hay proyectos. Crea uno y sube la fotografía del espacio del cliente.
          </div>
        )}
      </div>
    </div>
  );
}
