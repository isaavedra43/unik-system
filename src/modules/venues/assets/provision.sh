#!/usr/bin/env bash
# UNIK venue provisioning — runs INSIDE the Daytona sandbox.
#
# Makes any stock sandbox image browser-ready:
#   1. node.js (the controller is a node http server)
#   2. /tmp/unik/node_modules/playwright-core (the controller imports it)
#   3. a chromium binary — playwright-managed build first (works as a normal
#      user, no snap), system package as fallback where it is a real package
# Prints UNIK_* markers on stdout for the caller. Idempotent: safe to re-run
# on attach/restart. Everything is best-effort — the caller surfaces the tail
# of this output when the controller fails to reach health.
set -u
cd /tmp/unik || exit 1

log() { echo "[provision] $*"; }

# Daytona sandboxes run as a regular user with passwordless sudo; images run
# as root. Use whichever gets us package installs without prompting.
SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi
fi
OS_ID="$(. /etc/os-release 2>/dev/null && echo "${ID:-}")"
export DEBIAN_FRONTEND=noninteractive

# --- node -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "node ausente — intentando instalar"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y >/dev/null 2>&1 || true
    $SUDO apt-get install -y nodejs npm >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  # Last resort: official prebuilt tarball into /tmp/unik/node-dist.
  ARCH="$(uname -m)"; case "$ARCH" in aarch64|arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
  TARBALL="node-v20.19.0-linux-$NARCH.tar.xz"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://nodejs.org/dist/v20.19.0/$TARBALL" -o "/tmp/$TARBALL" 2>/dev/null \
      && tar -xJf "/tmp/$TARBALL" -C /tmp/unik 2>/dev/null \
      || true
    export PATH="/tmp/unik/node-v20.19.0-linux-$NARCH/bin:$PATH"
    $SUDO ln -sf "/tmp/unik/node-v20.19.0-linux-$NARCH/bin/node" /usr/local/bin/node 2>/dev/null || true
    $SUDO ln -sf "/tmp/unik/node-v20.19.0-linux-$NARCH/bin/npm" /usr/local/bin/npm 2>/dev/null || true
    $SUDO ln -sf "/tmp/unik/node-v20.19.0-linux-$NARCH/bin/npx" /usr/local/bin/npx 2>/dev/null || true
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
  NPM_OUT="$(npm install --no-audit --no-fund --loglevel=error playwright-core 2>&1 | tail -4)"
  [ -d node_modules/playwright-core ] || log "npm: $NPM_OUT"
fi
if [ ! -d node_modules/playwright-core ]; then
  echo "UNIK_PROV_FAIL=no-playwright-core (npm falló — ¿egress bloqueado por domainAllowList o sin red?)"
  exit 0
fi
echo "UNIK_PW=ok"

# --- chromium ---------------------------------------------------------------
find_chrome() {
  command -v chromium 2>/dev/null \
    || command -v chromium-browser 2>/dev/null \
    || command -v google-chrome 2>/dev/null \
    || command -v google-chrome-stable 2>/dev/null \
    || find "$HOME/.cache/ms-playwright" /ms-playwright /opt/ms-playwright -type f \( -name chrome -o -name headless_shell -o -name chromium \) 2>/dev/null | head -1
}
CHROME="$(find_chrome || true)"

# Ubuntu's `chromium` apt package is a snap stub that cannot run in a
# container — only Debian ships a real chromium deb. Playwright's own build
# works everywhere as a normal user, so it goes first; apt is the fallback.
if [ -z "$CHROME" ]; then
  if [ ! -d node_modules/playwright ]; then
    npm install --no-audit --no-fund --loglevel=error playwright >/dev/null 2>&1 || true
  fi
  npx --yes playwright install chromium >/dev/null 2>&1 || true
  # Shared libraries (libnss3, libgbm…) need root — best-effort.
  if [ -n "$SUDO" ] || [ "$(id -u)" = "0" ]; then
    $SUDO npx --yes playwright install-deps chromium >/dev/null 2>&1 || true
  fi
  CHROME="$(find_chrome || true)"
fi

if [ -z "$CHROME" ] && [ "$OS_ID" != "ubuntu" ] && command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update -y >/dev/null 2>&1 || true
  $SUDO apt-get install -y chromium >/dev/null 2>&1 \
    || $SUDO apt-get install -y chromium-browser >/dev/null 2>&1 \
    || true
  CHROME="$(find_chrome || true)"
fi

if [ -z "$CHROME" ]; then
  echo "UNIK_PROV_FAIL=no-chromium (ni playwright install ni apt consiguieron un binario)"
  exit 0
fi

# Missing shared libs are the classic silent failure: chromium "exists" but
# cannot start. Report it so the caller shows a real reason.
if command -v ldd >/dev/null 2>&1; then
  MISSING="$(ldd "$CHROME" 2>/dev/null | grep -c 'not found' || true)"
  if [ "${MISSING:-0}" != "0" ]; then
    log "chromium tiene $MISSING librerías faltantes — intentando install-deps"
    if [ -n "$SUDO" ] || [ "$(id -u)" = "0" ]; then
      $SUDO npx --yes playwright install-deps chromium >/dev/null 2>&1 || true
    fi
    MISSING="$(ldd "$CHROME" 2>/dev/null | grep -c 'not found' || true)"
    [ "${MISSING:-0}" != "0" ] && echo "UNIK_CHROME_MISSING_LIBS=$MISSING"
  fi
fi

echo "UNIK_CHROME_PATH=$CHROME"
echo "UNIK_PROV_OK=1"
