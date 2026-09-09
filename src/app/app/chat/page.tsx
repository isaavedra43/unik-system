import { requirePermission } from '@/modules/auth/authorization';
import { ChatPageClient } from '@/components/chat/ChatPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const user = await requirePermission('chat.use');
  return <ChatPageClient user={user} />;
}
