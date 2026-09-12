import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/modules/auth/authorization';
import { registerFileAccessResolver } from '@/modules/storage/storage-access';

/**
 * Download authorization for commercial packages (purpose `document`,
 * metadata.kind = quote_commercial_package). Knowing the object id grants
 * nothing: the actor needs a quotes permission and the quote must still exist.
 *
 * Imported by quotes-service (so every quotes API call registers it) and
 * intended to be imported from register-handlers.ts at boot.
 */
registerFileAccessResolver('document', async (actor, object) => {
  const meta = (object.metadata ?? {}) as { kind?: string; quoteId?: string };
  if (meta.kind !== 'quote_commercial_package' || !meta.quoteId) return false;
  if (!hasPermission(actor, 'quotes.use') && !hasPermission(actor, 'quotes.approve')) return false;
  // Metadata is server-generated at save time, so the quote link can be trusted;
  // older package versions of the same quote stay readable to quote users.
  const quote = await prisma.quote.findUnique({ where: { id: meta.quoteId }, select: { id: true } });
  return Boolean(quote);
});
