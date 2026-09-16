import { LoadingState } from '@/components/patterns/LoadingState';

/** Esqueleto mientras el Server Component arma la herramienta. */
export default function NeuralToolLoading() {
  return (
    <div className="neural-shell">
      <LoadingState variant="kpi" label="Cargando la herramienta…" />
      <LoadingState variant="table" rows={6} />
    </div>
  );
}
