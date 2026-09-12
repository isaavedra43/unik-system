import Link from 'next/link';
import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { buildPendingMap } from '@/modules/copilot/pending-map-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KIND_LABELS: Record<string, string> = {
  proposal: 'Aprobaciones',
  skill_run: 'Skills en espera',
  request: 'Solicitudes',
  commitment: 'Compromisos',
  quote: 'Cotizaciones',
  campaign: 'Campañas',
  memory: 'Memoria',
};

export default async function PendingPage() {
  const user = await requirePermission('assistant.use');
  const { items, counts } = await buildPendingMap(user);
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Mapa de pendientes"
        description="Todo lo que espera tu decisión o seguimiento, con sus dependencias. Primero lo que bloquea a otros."
      />
      <div className="assistant-admin-stat-grid">
        {Object.entries(counts).map(([kind, count]) => (
          <div key={kind} className="assistant-admin-stat-card">
            <div className="assistant-admin-stat-content">
              <div className="assistant-admin-stat-label">{KIND_LABELS[kind] ?? kind}</div>
              <div className="assistant-admin-stat-value">{count}</div>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="assistant-admin-empty">
            No tienes pendientes. Cuando el asistente proponga una acción o alguien te asigne algo,
            aparecerá aquí.
          </div>
        )}
      </div>
      <div className="assistant-admin-table-wrap">
        <table className="assistant-admin-table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Pendiente</th>
              <th>Estado</th>
              <th>Vence</th>
              <th>Depende de</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.kind}-${item.id}`}>
                <td>
                  {KIND_LABELS[item.kind] ?? item.kind}
                  {item.blocking && (
                    <span className="assistant-admin-badge assistant-admin-badge-error">
                      {' '}
                      bloquea
                    </span>
                  )}
                </td>
                <td>
                  {item.title}
                  {item.detail && <div className="assistant-admin-list-meta">{item.detail}</div>}
                </td>
                <td>
                  <span className="assistant-admin-badge">{item.status}</span>
                </td>
                <td>{item.dueAt ? new Date(item.dueAt).toLocaleString('es-MX') : '—'}</td>
                <td className="assistant-admin-muted">
                  {item.dependsOn.length > 0
                    ? item.dependsOn.map((d) => d.slice(0, 8)).join(', ')
                    : '—'}
                </td>
                <td>
                  <Link href={item.href} className="assistant-admin-test-btn">
                    Abrir
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
