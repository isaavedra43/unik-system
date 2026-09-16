import { redirect } from 'next/navigation';
import { NEURAL_BASE_PATH } from '@/components/control-tower/neural/neural-model';

export const runtime = 'nodejs';

/** `/neural` sin herramienta abre el visor de procesos. */
export default function NeuralIndexPage() {
  redirect(`${NEURAL_BASE_PATH}/procesos`);
}
