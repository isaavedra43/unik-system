import { redirect } from 'next/navigation';
import {
  CONTROL_TOWER_BASE_PATH,
  DEFAULT_CONTROL_TOWER_VIEW,
} from '@/components/control-tower/control-tower-views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/app/admin/control-tower` → the summary (plan 7.7). The permission is
 * checked by the view itself, so this redirect never leaks whether the person
 * may enter: they land on the same gate either way.
 */
export default async function ControlTowerIndexPage() {
  redirect(`${CONTROL_TOWER_BASE_PATH}/${DEFAULT_CONTROL_TOWER_VIEW}`);
}
