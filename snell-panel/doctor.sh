#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"

checks_failed=0
check_ok() { success "$1"; }
check_fail() { checks_failed=$((checks_failed + 1)); error "$1"; }

main() {
  require_project

  command_exists git && check_ok "git found: $(git --version)" || check_fail "git is missing."
  command_exists node && check_ok "node found: $(node --version)" || check_fail "node is missing."
  command_exists bun && check_ok "bun found: $(bun --version)" || check_fail "bun is missing. Run ./deploy.sh to install it."
  command_exists bun && (cd "$SERVER_DIR" && bunx wrangler --version >/dev/null 2>&1) && check_ok "Wrangler is available via bunx." || check_fail "Wrangler is not available."

  if command_exists bun; then
    if wrangler whoami >/dev/null 2>&1; then
      check_ok "Wrangler login is valid."
    else
      check_fail "Wrangler is not logged in. Run: cd apps/server && bunx wrangler login"
    fi
  fi

  if has_database_id; then
    db_id="$(current_database_id)"
    check_ok "D1 database_id configured: $db_id"
    if command_exists bun && wrangler d1 list 2>/dev/null | grep -q "$db_id"; then
      check_ok "D1 database exists in Cloudflare account."
    else
      check_fail "Could not verify D1 database in Cloudflare account."
    fi
  else
    check_fail "D1 database_id is missing or still uses the placeholder. Run ./deploy.sh."
  fi

  [[ -d "$SERVER_DIR/drizzle" ]] && check_ok "Migration directory exists: apps/server/drizzle" || check_fail "Missing apps/server/drizzle migrations directory."
  if command_exists bun && wrangler d1 migrations list "$PROJECT_NAME" --remote >/dev/null 2>&1; then
    check_ok "Remote D1 migrations are queryable."
  else
    check_fail "Could not query remote D1 migrations."
  fi
  if command_exists bun && wrangler secret list 2>/dev/null | grep -q 'ACCESS_TOKEN' && wrangler secret list 2>/dev/null | grep -q 'API_TOKEN'; then
    check_ok "ACCESS_TOKEN and API_TOKEN secrets exist."
  else
    check_fail "Could not verify ACCESS_TOKEN/API_TOKEN secrets."
  fi

  if [[ -n "${WORKER_URL:-}" ]]; then
    curl -fsS "$WORKER_URL" >/dev/null && check_ok "Worker URL is reachable." || check_fail "Worker URL is not reachable: $WORKER_URL"
    curl -fsS "$WORKER_URL/install.sh" >/dev/null && check_ok "/install.sh is reachable." || check_fail "/install.sh is not reachable."
    if [[ -n "${ACCESS_TOKEN:-}" ]]; then
      curl -fsS -H "Authorization: Bearer $ACCESS_TOKEN" "$WORKER_URL/api/settings" >/dev/null && check_ok "/api/settings is reachable with ACCESS_TOKEN." || check_fail "/api/settings check failed."
    else
      warn "Set ACCESS_TOKEN to let doctor check /api/settings."
    fi
  else
    warn "Set WORKER_URL=https://... to let doctor check Worker URL, /install.sh, and /api/settings."
  fi
  [[ -f "$PANEL_ROOT/bun.lock" ]] && check_ok "bun.lock exists." || warn "bun.lock is missing; bun install will regenerate it."

  if command_exists bun; then
    info "Running typecheck..."
    (cd "$PANEL_ROOT" && bun run typecheck) && check_ok "Typecheck passed." || check_fail "Typecheck failed."
  fi

  if [[ "$checks_failed" -eq 0 ]]; then
    printf '\n'
    success "Doctor finished: no blocking issues found."
  else
    printf '\n'
    fail "Doctor found $checks_failed issue(s)."
  fi
}

main "$@"
