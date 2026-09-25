import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PUSH_PROMPT_DISMISS_KEY,
  markPushPromptDismissed,
  shouldAskPush,
} from './push-prompt-gate';

/**
 * The gate runs in a real browser; here we fake just enough of window /
 * navigator / localStorage / Notification to cover every branch.
 */

const store = new Map<string, string>();

function stubBrowser({
  ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
  permission = 'default',
  standalone = false,
  hasNotification = true,
  maxTouchPoints = 0,
}: {
  ua?: string;
  permission?: 'default' | 'granted' | 'denied';
  standalone?: boolean;
  hasNotification?: boolean;
  maxTouchPoints?: number;
} = {}) {
  store.clear();
  const windowObj: Record<string, unknown> = {
    matchMedia: () => ({ matches: standalone }),
    navigator: { standalone },
  };
  if (hasNotification) {
    windowObj.Notification = { permission };
    // In a real browser window props are also bare globals.
    vi.stubGlobal('Notification', windowObj.Notification);
  }
  vi.stubGlobal('window', windowObj);
  vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints, standalone });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('shouldAskPush', () => {
  beforeEach(() => stubBrowser());
  afterEach(() => vi.unstubAllGlobals());

  it('asks when permission was never decided', () => {
    expect(shouldAskPush()).toBe(true);
  });

  it('does not ask again after dismissal', () => {
    markPushPromptDismissed();
    expect(shouldAskPush()).toBe(false);
    expect(store.get(PUSH_PROMPT_DISMISS_KEY)).toBeTruthy();
  });

  it('does not ask when permission is already granted', () => {
    stubBrowser({ permission: 'granted' });
    expect(shouldAskPush()).toBe(false);
  });

  it('does not ask when permission is denied (cannot re-prompt anyway)', () => {
    stubBrowser({ permission: 'denied' });
    expect(shouldAskPush()).toBe(false);
  });

  it('does not ask when Notification is unavailable on a non-iOS browser', () => {
    stubBrowser({ hasNotification: false });
    expect(shouldAskPush()).toBe(false);
  });

  it('asks on iOS Safari before install even without Notification', () => {
    stubBrowser({ ua: IPHONE_UA, hasNotification: false, standalone: false });
    expect(shouldAskPush()).toBe(true);
  });

  it('asks on iOS Safari before install when permission is default', () => {
    stubBrowser({ ua: IPHONE_UA, permission: 'default', standalone: false });
    expect(shouldAskPush()).toBe(true);
  });

  it('does not ask on iOS Safari when denied', () => {
    stubBrowser({ ua: IPHONE_UA, permission: 'denied', standalone: false });
    expect(shouldAskPush()).toBe(false);
  });

  it('asks on installed iOS PWA when permission is default', () => {
    stubBrowser({ ua: IPHONE_UA, permission: 'default', standalone: true });
    expect(shouldAskPush()).toBe(true);
  });
});
