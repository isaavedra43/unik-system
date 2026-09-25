#!/usr/bin/env bash
# Production migration runner (Railway pre-deploy).
#
# 1. resolve-failed-migrations.mjs clears any stale "failed" record so a
#    previous bad attempt can never brick this deploy with P3009.
# 2. migrate deploy then applies pending migrations. All repo migrations are
#    additive + idempotent (AGENTS.md → Migraciones), so a re-run always
#    converges instead of failing mid-way on existing data.
set -euo pipefail

node "$(dirname "$0")/resolve-failed-migrations.mjs"
exec npx prisma migrate deploy
