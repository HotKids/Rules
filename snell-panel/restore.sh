#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"
trap on_error ERR

main() {
  require_project
  ensure_runtime_tools
  ensure_wrangler_login
  has_database_id || fail "No D1 database_id configured; run ./deploy.sh first."
  local file="${1:-}"
  [[ -n "$file" ]] || fail "Usage: ./restore.sh backups/<file.sql>"
  [[ -f "$file" ]] || fail "SQL file not found: $file"
  warn "This will execute SQL against the remote D1 database: $(current_database_id)"
  confirm "Continue restoring $file?" "N" || fail "Restore cancelled."
  wrangler d1 execute "$PROJECT_NAME" --remote --file "$file"
  success "Restore complete."
}

main "$@"
