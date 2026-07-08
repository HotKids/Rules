#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"
trap on_error ERR

main() {
  parse_common_args "$@"
  require_project
  ensure_runtime_tools

  local repo_root
  if repo_root="$(git -C "$PANEL_ROOT" rev-parse --show-toplevel 2>/dev/null)"; then
    info "Updating repository with git pull from $repo_root..."
    (cd "$repo_root" && git pull --ff-only)
  else
    warn "snell-panel is not inside a git checkout; skipping git pull. Update the files manually before continuing."
  fi

  install_dependencies
  ensure_wrangler_login
  ensure_d1_database
  info "Applying remote migrations through package script..."
  (cd "$PANEL_ROOT" && bun run --filter '@snell-panel/server' db:migrate:remote)

  if confirm "Overwrite ACCESS_TOKEN/API_TOKEN secrets during this update?" "N"; then
    configure_secrets
  else
    success "Keeping existing Cloudflare secrets."
  fi

  build_panel
  deploy_worker
  health_check_worker
  print_status "Update"
}

main "$@"
