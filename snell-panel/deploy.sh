#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"
trap on_error ERR

main() {
  require_project
  ensure_runtime_tools
  install_dependencies
  ensure_wrangler_login
  ensure_d1_database
  apply_remote_migrations
  if confirm "Configure or overwrite ACCESS_TOKEN/API_TOKEN secrets now?" "Y"; then
    configure_secrets
  else
    success "Skipping secret changes; existing Cloudflare secrets are kept."
  fi
  build_panel
  deploy_worker
  print_status "Deployment"
}

main "$@"
