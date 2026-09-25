#!/usr/bin/env bash
# UNIK venue provisioning — runs INSIDE the Daytona sandbox.
#
# Makes any stock sandbox image browser-ready:
#   1. /tmp/unik/node_modules/playwright-core (the controller imports it)
#   2. a chromium binary — system package first, playwright-managed fallback
# Prints `UNIK_CHROME_PATH=<path>` on stdout for the caller to export into the
# controller's env. Idempotent: safe to re-run on attach/restart.
set -u
cd /tmp/unik || exit 1

# --- node deps -------------------------------------------------------------
if [ ! -d node_modules/playwright-core ]; then
  [ -f package.json ] || npm init -y >/dev/null 2>&1 || true
  npm install --no-audit --no-fund --loglevel=error playwright-core >/dev/null 2>&1 || true
fi

# --- chromium ---------------------------------------------------------------
CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true)"

if [ -z "$CHROME" ] && command -v apt-get >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y chromium >/dev/null 2>&1 \
    || apt-get install -y chromium-browser >/dev/null 2>&1 \
    || true
  CHROME="$(command -v chromium || command -v chromium-browser || true)"
fi

if [ -z "$CHROME" ]; then
  # Last resort: playwright-managed browser into ~/.cache/ms-playwright.
  if [ ! -d node_modules/playwright ]; then
    npm install --no-audit --no-fund --loglevel=error playwright >/dev/null 2>&1 || true
  fi
  npx --yes playwright install chromium --with-deps >/dev/null 2>&1 \
    || npx --yes playwright install chromium >/dev/null 2>&1 || true
  CHROME="$(find "$HOME/.cache/ms-playwright" -type f \( -name headless_shell -o -name chrome \) 2>/dev/null | head -1 || true)"
fi

echo "UNIK_CHROME_PATH=$CHROME"
