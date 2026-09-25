#!/usr/bin/env bash
# UNIK venue provisioning — runs INSIDE the Daytona sandbox.
#
# Makes any stock sandbox image browser-ready:
#   1. node.js (the controller is a node http server)
#   2. /tmp/unik/node_modules/playwright-core (the controller imports it)
#   3. a chromium binary — system package first, playwright-managed fallback
# Prints UNIK_* markers on stdout for the caller. Idempotent: safe to re-run
# on attach/restart. Everything is best-effort — the caller surfaces the tail
# of this output when the controller fails to reach health.
set -u
cd /tmp/unik || exit 1

log() { echo "[provision] $*"; }

# --- node -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "node ausente — intentando instalar"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y nodejs npm >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  # Last resort: official prebuilt tarball into /tmp/unik/node-dist.
  ARCH="$(uname -m)"; case "$ARCH" in aarch64|arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
  TARBALL="node-v20.19.0-linux-$NARCH.tar.xz"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://nodejs.org/dist/v20.19.0/$TARBALL" -o "/tmp/$TARBALL" 2>/dev/null \
      && tar -xJf "/tmp/$TARBALL" -C /tmp/unik 2>/dev/null \
      && ln -sf "/tmp/unik/node-v20.19.0-linux-$NARCH/bin/node" /usr/local/bin/node 2>/dev/null \
      && ln -sf "/tmp/unik/node-v20.19.0-linux-$NARCH/bin/npm" /usr/local/bin/npm 2>/dev/null \
      && ln -sf "/tmp/unik/node-v20.19.0-linux-$NARCH/bin/npx" /usr/local/bin/npx 2>/dev/null \
      || true
    export PATH="/tmp/unik/node-v20.19.0-linux-$NARCH/bin:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "UNIK_PROV_FAIL=no-node"
  exit 0
fi
echo "UNIK_NODE=$(node --version 2>/dev/null || echo '?')"

# --- node deps --------------------------------------------------------------
if [ ! -d node_modules/playwright-core ]; then
  [ -f package.json ] || npm init -y >/dev/null 2>&1 || true
  npm install --no-audit --no-fund --loglevel=error playwright-core >/dev/null 2>&1 || true
fi
if [ ! -d node_modules/playwright-core ]; then
  echo "UNIK_PROV_FAIL=no-playwright-core (npm falló — ¿egress bloqueado por domainAllowList?)"
  exit 0
fi
echo "UNIK_PW=ok"

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

if [ -z "$CHROME" ]; then
  echo "UNIK_PROV_FAIL=no-chromium"
  exit 0
fi

echo "UNIK_CHROME_PATH=$CHROME"
echo "UNIK_PROV_OK=1"
