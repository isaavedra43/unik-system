import { describe, expect, it } from 'vitest';
import { inferComposioEffect, resolveComposioEffect, stripToolkitPrefix } from './composio-effects';

describe('composio effects', () => {
  it.each([
    ['GMAIL_FETCH_EMAILS', 'gmail', 'read'],
    ['GMAIL_LIST_LABELS', 'gmail', 'read'],
    ['GITHUB_LIST_REPOSITORY_ISSUES', 'github', 'read'],
    ['GOOGLECALENDAR_FIND_EVENT', 'googlecalendar', 'read'],
    ['SLACK_SEARCH_MESSAGES', 'slack', 'read'],
    ['NOTION_QUERY_DATABASE', 'notion', 'read'],
    ['GMAIL_SEND_EMAIL', 'gmail', 'external_send'],
    ['SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'slack', 'external_send'],
    ['GMAIL_REPLY_TO_THREAD', 'gmail', 'external_send'],
    ['GMAIL_CREATE_EMAIL_DRAFT', 'gmail', 'draft'],
    ['GITHUB_CREATE_AN_ISSUE', 'github', 'business_write'],
    ['GOOGLESHEETS_BATCH_UPDATE', 'googlesheets', 'business_write'],
    ['GMAIL_DELETE_MESSAGE', 'gmail', 'destructive'],
    ['GITHUB_DELETE_A_REPOSITORY', 'github', 'destructive'],
    ['GOOGLEDRIVE_TRASH_FILE', 'googledrive', 'destructive'],
    ['STRIPE_GET_OR_CREATE_CUSTOMER', 'stripe', 'business_write'],
    ['NOTION_SOMETHING_UNKNOWN', 'notion', 'business_write'],
    ['GMAIL_LIST_DELETED_MESSAGES', 'gmail', 'read'],
    ['GMAIL_FETCH_SENT_EMAILS', 'gmail', 'read'],
  ])('%s → %s', (slug, toolkit, expected) => {
    expect(inferComposioEffect(slug, { toolkit })).toBe(expected);
  });

  it('strips multi-token toolkit prefixes', () => {
    expect(stripToolkitPrefix('GOOGLE_CALENDAR_FIND_EVENT', 'googlecalendar')).toEqual([
      'FIND',
      'EVENT',
    ]);
    expect(stripToolkitPrefix('GITHUB_GET_REPO', undefined)).toEqual(['GET', 'REPO']);
  });

  it('tags can only escalate, never relax', () => {
    expect(inferComposioEffect('X_GET_THING', { toolkit: 'x', tags: ['destructiveHint'] })).toBe(
      'destructive'
    );
    expect(inferComposioEffect('X_DELETE_THING', { toolkit: 'x', tags: ['readOnlyHint'] })).toBe(
      'destructive'
    );
  });

  it('admin override wins and invalid overrides are ignored', () => {
    expect(
      resolveComposioEffect('GMAIL_SEND_EMAIL', {
        toolkit: 'gmail',
        overrides: { GMAIL_SEND_EMAIL: 'draft' },
      })
    ).toBe('draft');
    expect(
      resolveComposioEffect('GMAIL_SEND_EMAIL', {
        toolkit: 'gmail',
        overrides: { GMAIL_SEND_EMAIL: 'nope' },
      })
    ).toBe('external_send');
  });
});
