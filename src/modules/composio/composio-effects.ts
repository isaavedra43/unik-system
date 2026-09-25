import type { ToolEffect } from '@/modules/ai/tools/registry';

/**
 * Effect classification for Composio tools.
 *
 * UNIK decides what a tool does — never the tool itself or its tags. Composio
 * slugs look like `GMAIL_SEND_EMAIL` / `GITHUB_LIST_REPOSITORY_ISSUES`, so the
 * verb after the toolkit prefix is a reliable signal. The rules are
 * conservative: a tool is only `read` when its verb is clearly a read verb and
 * no write/send/delete verb appears anywhere in the slug. Anything unknown is
 * `business_write` (needs approval). Composio hints can only ESCALATE an effect
 * (a `destructiveHint` tag), never relax it. An administrator override per tool
 * (ComposioToolkitPolicy.effectOverrides) always wins.
 */

export const COMPOSIO_EFFECTS: readonly ToolEffect[] = [
  'read',
  'draft',
  'internal_task',
  'external_send',
  'business_write',
  'destructive',
];

const plural = (verbs: string[]) => new RegExp(`^(?:${verbs.join('|')})(?:S|ES)?$`);

const DESTRUCTIVE = plural([
  'DELETE',
  'REMOVE',
  'TRASH',
  'DESTROY',
  'PURGE',
  'REVOKE',
  'CLEAR',
  'DROP',
  'TERMINATE',
  'CANCEL',
  'WIPE',
  'ERASE',
  'UNINSTALL',
  'DEACTIVATE',
  'DISABLE',
  'UNLINK',
  'DISCONNECT',
  'EMPTY',
]);
const EXTERNAL_SEND = plural([
  'SEND',
  'POST',
  'REPLY',
  'FORWARD',
  'PUBLISH',
  'INVITE',
  'TWEET',
  'SHARE',
  'NOTIFY',
  'BROADCAST',
  'SUBMIT',
  'DISPATCH',
]);
const WRITE = plural([
  'CREATE',
  'UPDATE',
  'ADD',
  'EDIT',
  'MODIFY',
  'PATCH',
  'SET',
  'INSERT',
  'APPEND',
  'UPLOAD',
  'MOVE',
  'RENAME',
  'ASSIGN',
  'CLOSE',
  'REOPEN',
  'MERGE',
  'COMMIT',
  'APPROVE',
  'COMPLETE',
  'MARK',
  'WRITE',
  'IMPORT',
  'RUN',
  'EXECUTE',
  'TRIGGER',
  'START',
  'STOP',
  'ENABLE',
  'FORK',
  'COPY',
  'REPLACE',
  'LOCK',
  'UNLOCK',
  'TRANSFER',
  'PAY',
  'CHARGE',
  'REFUND',
  'BOOK',
  'SCHEDULE',
  'REGISTER',
  'SUBSCRIBE',
  'UNSUBSCRIBE',
  'ARCHIVE',
  'RESTORE',
  'RESET',
  'SYNC',
  'CONNECT',
  'INVOKE',
  'PUT',
  'SAVE',
  'REACT',
  'RESOLVE',
  'REJECT',
  'ACCEPT',
  'DECLINE',
  'ENROLL',
  'PROVISION',
  'GRANT',
  'CONFIGURE',
  'CONVERT',
  'GENERATE',
  'BUY',
  'SELL',
  'DEPLOY',
  'PUSH',
]);
const DRAFT = /^DRAFTS?$/;
const READ = plural([
  'GET',
  'LIST',
  'SEARCH',
  'FETCH',
  'FIND',
  'READ',
  'RETRIEVE',
  'QUERY',
  'LOOKUP',
  'CHECK',
  'DESCRIBE',
  'SHOW',
  'VIEW',
  'COUNT',
  'DOWNLOAD',
  'LOAD',
  'BROWSE',
  'EXPORT',
  'PREVIEW',
  'VALIDATE',
  'VERIFY',
  'RESOLVE_ID',
  'WHOAMI',
  'FILTER',
  'SUMMARIZE',
  'LOOK',
  'SCAN',
  'OBSERVE',
  'WATCH_STATUS',
]);

export function stripToolkitPrefix(slug: string, toolkit?: string | null): string[] {
  const tokens = slug.toUpperCase().split('_').filter(Boolean);
  if (tokens.length === 0) return tokens;
  const tk = toolkit ? toolkit.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (tk) {
    let acc = '';
    for (let i = 0; i < tokens.length; i += 1) {
      acc += tokens[i];
      if (acc === tk) return tokens.slice(i + 1);
      if (!tk.startsWith(acc)) break;
    }
  }
  return tokens.slice(1);
}

export function inferComposioEffect(
  slug: string,
  options: { toolkit?: string | null; tags?: string[] | null } = {}
): ToolEffect {
  const rest = stripToolkitPrefix(slug, options.toolkit);
  const tags = (options.tags ?? []).map((t) => t.toLowerCase());
  const hasDestructiveTag = tags.includes('destructivehint');

  // Verbs live at the start ("CREATE_AN_ISSUE", "BATCH_UPDATE", "GET_OR_CREATE_…"); later tokens are
  // usually nouns ("LABELS", "ORDER") and must not turn a read into a write.
  const lead = rest.slice(0, 4);

  let effect: ToolEffect;
  if (rest.length === 0) {
    effect = 'business_write';
  } else if (rest.some((t) => DESTRUCTIVE.test(t))) {
    effect = 'destructive';
  } else if (lead.some((t) => EXTERNAL_SEND.test(t))) {
    effect = 'external_send';
  } else if (rest.some((t) => DRAFT.test(t))) {
    effect = 'draft';
  } else if (lead.some((t) => WRITE.test(t))) {
    effect = 'business_write';
  } else if (READ.test(rest[0])) {
    effect = 'read';
  } else {
    effect = 'business_write';
  }

  if (hasDestructiveTag) return 'destructive';
  return effect;
}

export function isComposioEffect(value: unknown): value is ToolEffect {
  return typeof value === 'string' && (COMPOSIO_EFFECTS as readonly string[]).includes(value);
}

/** Admin override → inferred effect. Invalid overrides are ignored. */
export function resolveComposioEffect(
  slug: string,
  options: {
    toolkit?: string | null;
    tags?: string[] | null;
    overrides?: Record<string, unknown> | null;
  } = {}
): ToolEffect {
  const override = options.overrides?.[slug.toUpperCase()] ?? options.overrides?.[slug];
  if (isComposioEffect(override)) return override;
  return inferComposioEffect(slug, options);
}

/** Toolkit slug from a tool slug when the toolkit is not known (best effort, lowercase first token). */
export function guessToolkitFromSlug(slug: string): string {
  return slug.split('_')[0]?.toLowerCase() ?? '';
}
