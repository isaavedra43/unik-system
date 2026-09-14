import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/app-url';
import { protectArtifact } from './ai-artifacts-service';

/**
 * Signed share links for AI artifacts (reports, quote PDFs).
 *
 * The regular download route only serves the owner of the conversation. When
 * the assistant sends a report to a colleague (internal chat) or a customer
 * (WhatsApp) the recipient is not that owner, so we hand out a tamper-proof
 * link: `/api/files/shared/<artifactId>.<expires>.<hmac>`. Sharing also marks
 * the artifact as protected so the periodic cleanup never deletes it.
 */

const DEFAULT_TTL_DAYS = 90;

function secret(): string {
  const raw = process.env.UNIK_SHARE_LINK_SECRET || process.env.UNIK_SECRETS_MASTER_KEY || process.env.DATABASE_URL || '';
  if (!raw) throw new Error('UNIK_SHARE_LINK_SECRET (o UNIK_SECRETS_MASTER_KEY) no está configurada');
  return raw;
}

function sign(artifactId: string, expires: number): string {
  return createHmac('sha256', secret()).update(`${artifactId}.${expires}`).digest('base64url').slice(0, 32);
}

export function buildShareToken(artifactId: string, ttlDays = DEFAULT_TTL_DAYS): string {
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, ttlDays) * 86_400;
  return `${artifactId}.${expires}.${sign(artifactId, expires)}`;
}

export function verifyShareToken(rawToken: string): { artifactId: string } | null {
  // Messaging clients sometimes glue the sentence's period/paren to the link.
  const token = decodeURIComponent(rawToken).replace(/[.,;:!?)\]]+$/, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [artifactId, expiresRaw, mac] = parts;
  const expires = Number(expiresRaw);
  if (!artifactId || !Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return null;
  const expected = sign(artifactId, expires);
  if (expected.length !== mac.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  } catch {
    return null;
  }
  return { artifactId };
}

export function shareUrlFor(artifactId: string, ttlDays = DEFAULT_TTL_DAYS): string {
  return absoluteUrl(`/api/files/shared/${buildShareToken(artifactId, ttlDays)}`);
}

/**
 * Creates a share link for an artifact owned by `userId` and protects it.
 * Returns null when the artifact does not exist or belongs to someone else.
 */
export async function shareArtifact(artifactId: string, userId: string, ttlDays = DEFAULT_TTL_DAYS): Promise<{ url: string; title: string; filename: string } | null> {
  const artifact = await prisma.aiArtifact.findUnique({
    where: { id: artifactId },
    select: { id: true, storageObjectId: true, storagePath: true, meta: true, conversation: { select: { userId: true } } },
  });
  if (!artifact || artifact.conversation.userId !== userId) return null;
  if (!artifact.storageObjectId && !artifact.storagePath) return null;
  await protectArtifact(artifactId, true);
  const meta = (artifact.meta as Record<string, unknown> | null) ?? {};
  return {
    url: shareUrlFor(artifactId, ttlDays),
    title: typeof meta.title === 'string' ? meta.title : 'Documento',
    filename: typeof meta.filename === 'string' ? meta.filename : `${artifactId}.bin`,
  };
}

const DOWNLOAD_URL_RE = /(?:https?:\/\/[^\s)]+)?\/app\/assistant\/api\/artifacts\/([a-z0-9]+)\/download/gi;

/**
 * Replaces private artifact download links inside a message with public share
 * links (for recipients who are not the owner). Unknown/foreign ids are left as is.
 */
export async function rewriteArtifactLinksForSharing(text: string, userId: string): Promise<{ text: string; shared: string[] }> {
  const shared: string[] = [];
  const ids = new Set<string>();
  for (const match of text.matchAll(DOWNLOAD_URL_RE)) ids.add(match[1]);
  if (ids.size === 0) return { text, shared };
  const map = new Map<string, string>();
  for (const id of ids) {
    const link = await shareArtifact(id, userId).catch(() => null);
    if (link) {
      map.set(id, link.url);
      shared.push(id);
    }
  }
  const rewritten = text.replace(DOWNLOAD_URL_RE, (full, id: string) => map.get(id) ?? full);
  return { text: rewritten, shared };
}

/** Markdown links `[label](url)` → `label: url` for channels that render plain text (WhatsApp, SMS, chat). */
export function markdownLinksToPlain(text: string): string {
  // A period right after the URL breaks the link on some clients: keep a space before it.
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)([.,;:!?])?/g, (_m, label: string, url: string, p?: string) => `${label.trim()}: ${url}${p ? ` ${p}` : ''}`);
}
