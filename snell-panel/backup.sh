#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"
trap on_error ERR

main() {
  require_project
  ensure_runtime_tools
  ensure_wrangler_login
  has_database_id || fail "No D1 database_id configured; run ./deploy.sh first."
  mkdir -p "$PANEL_ROOT/backups"
  local file="$PANEL_ROOT/backups/snell-panel-$(date +%Y%m%d-%H%M%S).sql"
  info "Exporting remote D1 database to $file..."
  wrangler d1 export "$PROJECT_NAME" --remote --output "$file"
  success "Backup complete: $file"
}

main "$@"
