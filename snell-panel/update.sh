#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/deploy-common.sh"
trap on_error ERR

refresh_project_paths() {
  PANEL_ROOT="$1"
  SERVER_DIR="$PANEL_ROOT/apps/server"
  WRANGLER_CONFIG="$SERVER_DIR/wrangler.jsonc"
}

ensure_clean_worktree() {
  local repo_root="$1"
  if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
    fail "Working tree has uncommitted changes. Commit/stash them before update."
  fi
}

pull_latest_code() {
  local repo_root branch
  if repo_root="$(git -C "$PANEL_ROOT" rev-parse --show-toplevel 2>/dev/null)"; then
    ensure_clean_worktree "$repo_root"
    branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"
    [[ "$branch" != "HEAD" ]] || fail "Current Git checkout is detached HEAD. Checkout a branch before update."

    info "Fetching latest code from origin..."
    (cd "$repo_root" && git fetch origin)

    info "Rebasing current branch '$branch' onto origin/$branch..."
    if ! (cd "$repo_root" && git pull --rebase origin "$branch"); then
      fail "git pull --rebase failed. Resolve conflicts manually, then rerun ./update.sh."
    fi
    success "Git repository updated from origin/$branch."
    return
  fi

  if [[ -z "${UPDATE_REPO_URL:-}" ]]; then
    fail "Current directory is not a Git checkout, so code can't be pulled automatically. Deploy via 'git clone', or set UPDATE_REPO_URL to a remote repo to re-clone."
  fi

  local current_dir parent_dir backup_dir new_root
  current_dir="$(basename "$PANEL_ROOT")"
  parent_dir="$(dirname "$PANEL_ROOT")"
  backup_dir="$parent_dir/$current_dir.bak-$(date +%Y%m%d%H%M%S)"
  new_root="$parent_dir/$current_dir"

  info "Current directory is not a Git checkout; cloning from UPDATE_REPO_URL."
  info "Moving current directory to $backup_dir"
  mv "$PANEL_ROOT" "$backup_dir"

  info "Cloning $UPDATE_REPO_URL into $new_root"
  (cd "$parent_dir" && git clone "$UPDATE_REPO_URL" "$current_dir")

  if [[ -f "$backup_dir/apps/server/wrangler.jsonc" && -f "$new_root/apps/server/wrangler.jsonc" ]]; then
    info "Preserving existing apps/server/wrangler.jsonc from backup."
    cp "$backup_dir/apps/server/wrangler.jsonc" "$new_root/apps/server/wrangler.jsonc"
  fi

  cd "$new_root"
  refresh_project_paths "$new_root"
  success "Repository cloned. Backup kept at $backup_dir"
}

main() {
  parse_common_args "$@"
  require_project
  ensure_runtime_tools
  pull_latest_code
  require_project

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
