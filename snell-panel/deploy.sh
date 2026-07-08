#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"
trap on_error ERR

main() {
  parse_common_args "$@"
  require_project
  ensure_runtime_tools
  install_dependencies
  ensure_wrangler_login
  ensure_d1_database
  apply_remote_migrations
  build_panel

  info "Deploying Worker before secret upload so Cloudflare creates a normal first deployment."
  deploy_worker

  if confirm "Configure or overwrite ACCESS_TOKEN/API_TOKEN secrets now?" "Y"; then
    configure_secrets
    info "Deploying final Worker version after secret upload..."
    deploy_worker
  else
    success "Skipping secret changes; existing Cloudflare secrets are kept."
  fi

  health_check_worker
  print_status "Deployment"
}

main "$@"
