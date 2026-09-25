/**
 * Gate for the one-time push-enable prompt: decides whether this device should
 * be asked to turn on notifications, and remembers the answer per browser
 * profile. Kept free of React/DOM-UI imports so it can be unit-tested in node.
 */

import { isIos, isStandalone } from './usePushSubscription';

export const PUSH_PROMPT_DISMISS_KEY = 'unik.pushPrompt.v1.dismissedAt';

export function markPushPromptDismissed() {
  try {
    localStorage.setItem(PUSH_PROMPT_DISMISS_KEY, String(Date.now()));
  } catch {
    // Private mode without storage — the dialog simply won't persist dismissal.
  }
}

export function shouldAskPush(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (localStorage.getItem(PUSH_PROMPT_DISMISS_KEY)) return false;
  } catch {
    // Storage blocked — still allow one ask this session.
  }
  if (isIos() && !isStandalone()) {
    // iOS Safari has no PushManager until the app is installed; the dialog
    // shows the install steps instead of a permission button. `Notification`
    // may not even exist in this context.
    return 'Notification' in window ? Notification.permission !== 'denied' : true;
  }
  // 'granted' → already subscribed or about to be; 'denied' → can't re-ask
  // programmatically, the settings page explains how to unblock.
  return 'Notification' in window && Notification.permission === 'default';
}
