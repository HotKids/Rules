#!/usr/bin/env bash

PROJECT_NAME="snell-panel"
PANEL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$PANEL_ROOT/apps/server"
WRANGLER_CONFIG="$SERVER_DIR/wrangler.jsonc"
PLACEHOLDER_DB_ID="replace-with-your-d1-database-id"
LAST_WORKER_URL=""

info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[DONE]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
fail() { error "$*"; exit 1; }

on_error() {
  local exit_code=$?
  error "Command failed with exit code ${exit_code}. Fix the message above and rerun the script."
  exit "$exit_code"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  local prompt="$1"
  local default="${2:-N}"
  local suffix="[y/N]"
  [[ "$default" =~ ^[Yy]$ ]] && suffix="[Y/n]"
  local answer
  read -r -p "$prompt $suffix: " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]
}

require_project() {
  [[ -d "$SERVER_DIR" ]] || fail "apps/server not found. Keep these scripts inside Rules/snell-panel."
  [[ -f "$WRANGLER_CONFIG" ]] || fail "Missing apps/server/wrangler.jsonc."
}

install_with_apt() {
  local package="$1"
  command_exists sudo || fail "sudo is required to install $package with apt. Install $package manually and rerun."
  sudo apt-get update
  sudo apt-get install -y "$package"
}

install_with_brew() {
  local package="$1"
  command_exists brew || fail "Homebrew is not installed. Install $package manually and rerun."
  brew install "$package"
}

ensure_git() {
  if command_exists git; then
    success "git: $(git --version)"
    return
  fi
  warn "git is not installed."
  case "$(uname -s)" in
    Linux) command_exists apt-get && install_with_apt git || fail "Only apt-based Debian/Ubuntu Linux is supported for automatic git installation." ;;
    Darwin) command_exists brew && install_with_brew git || fail "Install git with Homebrew or run: xcode-select --install" ;;
    *) fail "Unsupported OS. Supported: Debian, Ubuntu, macOS." ;;
  esac
}

ensure_bun() {
  if command_exists bun; then
    success "bun: $(bun --version)"
    return
  fi
  warn "bun is not installed."
  case "$(uname -s)" in
    Linux|Darwin)
      command_exists curl || fail "curl is required to install bun."
      curl -fsSL https://bun.sh/install | bash
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      command_exists bun || fail "bun installed, but is not on PATH. Add $BUN_INSTALL/bin to PATH and rerun."
      ;;
    *) fail "Unsupported OS. Supported: Debian, Ubuntu, macOS." ;;
  esac
}

ensure_node() {
  if command_exists node; then success "node: $(node --version)"; else fail "node is required by Wrangler. Install Node.js 20+ and rerun."; fi
}

ensure_curl() {
  if command_exists curl; then success "curl: installed"; else fail "curl is required. Install curl and rerun."; fi
}

ensure_openssl() {
  if command_exists openssl; then success "openssl: $(openssl version | awk '{print $1, $2}')"; else warn "openssl is missing; token generation will use a weaker fallback."; fi
}

ensure_wrangler() {
  info "Checking Wrangler availability via bunx..."
  (cd "$SERVER_DIR" && bunx wrangler --version >/dev/null)
  success "wrangler: available"
}

ensure_runtime_tools() {
  ensure_git
  ensure_bun
  ensure_node
  ensure_curl
  ensure_openssl
  ensure_wrangler
}

install_dependencies() {
  info "Installing Bun workspace dependencies..."
  (cd "$PANEL_ROOT" && bun install)
}

wrangler() {
  (cd "$SERVER_DIR" && bunx wrangler "$@")
}

ensure_wrangler_login() {
  info "Checking Cloudflare Wrangler login..."
  if wrangler whoami >/dev/null 2>&1; then
    success "Wrangler is logged in."
  else
    warn "Wrangler is not logged in; starting browser login."
    wrangler login
  fi
}

current_database_id() {
  sed -n 's/.*"database_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WRANGLER_CONFIG" | head -n 1
}

has_database_id() {
  local database_id
  database_id="$(current_database_id)"
  [[ -n "$database_id" && "$database_id" != "$PLACEHOLDER_DB_ID" ]]
}

write_database_id() {
  local database_id="$1"
  [[ -n "$database_id" ]] || fail "database_id cannot be empty."
  DATABASE_ID="$database_id" perl -0pi -e 's/("database_id"\s*:\s*")[^"]*(")/$1$ENV{DATABASE_ID}$2/s' "$WRANGLER_CONFIG"
  [[ "$(current_database_id)" == "$database_id" ]] || fail "Failed to write database_id into apps/server/wrangler.jsonc."
  success "database_id saved to apps/server/wrangler.jsonc."
}

extract_database_id() {
  sed -nE 's/.*database_id[[:space:]]*=[[:space:]]*"?([0-9a-fA-F-]{20,})"?.*/\1/p; s/.*"database_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1
}

ensure_d1_database() {
  if has_database_id; then
    success "D1 database configured: $(current_database_id)"
    return
  fi

  warn "No usable D1 database_id is configured."
  if confirm "Reuse an existing D1 database_id?" "N"; then
    local manual_id
    read -r -p "Existing D1 database_id: " manual_id
    write_database_id "$manual_id"
    return
  fi

  info "Creating D1 database '$PROJECT_NAME' from apps/server..."
  local output status database_id
  set +e
  output="$(wrangler d1 create "$PROJECT_NAME" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"

  if [[ "$status" -ne 0 ]]; then
    warn "D1 creation failed. This usually means the database already exists or the account lacks permission."
    read -r -p "Paste an existing D1 database_id to continue, or leave empty to abort: " database_id
    [[ -n "$database_id" ]] || fail "No D1 database_id provided."
    write_database_id "$database_id"
    return
  fi

  database_id="$(printf '%s\n' "$output" | extract_database_id)"
  [[ -n "$database_id" ]] || fail "Could not parse database_id from Wrangler output. Paste it into apps/server/wrangler.jsonc and rerun."
  write_database_id "$database_id"
}

apply_remote_migrations() {
  info "Applying remote D1 migrations from apps/server..."
  wrangler d1 migrations apply "$PROJECT_NAME" --remote
}

generate_token() {
  if command_exists openssl; then
    openssl rand -hex 24
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    local first second
    first="$(cat /proc/sys/kernel/random/uuid)"
    second="$(cat /proc/sys/kernel/random/uuid)"
    printf '%s%s\n' "${first//-/}" "${second//-/}" | cut -c 1-48
  elif command_exists shasum; then
    printf '%s-%s\n' "$(date +%s%N)" "$RANDOM" | shasum -a 256 | awk '{print substr($1, 1, 48)}'
  else
    printf '%s%s%s\n' "$(date +%s)" "$RANDOM" "$RANDOM"
  fi
}

read_secret_value() {
  local name="$1"
  local value=""
  if confirm "Auto-generate $name?" "Y"; then
    value="$(generate_token)"
    printf '\033[1;32m[DONE]\033[0m %s generated automatically. Save it from the final summary.\n' "$name" >&2
  else
    read -r -s -p "Enter $name: " value
    printf '\n'
  fi
  [[ -n "$value" ]] || fail "$name cannot be empty."
  printf '%s' "$value"
}

put_secret() {
  local name="$1"
  local value="$2"
  info "Uploading secret $name from apps/server..."
  printf '%s' "$value" | wrangler secret put "$name"
}

configure_secrets() {
  local access_token api_token
  access_token="$(read_secret_value ACCESS_TOKEN)"
  api_token="$(read_secret_value API_TOKEN)"
  put_secret ACCESS_TOKEN "$access_token"
  put_secret API_TOKEN "$api_token"
  export SNELL_PANEL_ACCESS_TOKEN="$access_token"
  export SNELL_PANEL_API_TOKEN="$api_token"
}

build_panel() {
  info "Building web frontend..."
  (cd "$PANEL_ROOT" && bun run build)
}

extract_worker_url() {
  sed -nE 's#.*(https://[^[:space:]]+\.workers\.dev).*#\1#p; s#.*(https://[^[:space:]]+)#\1#p' | tail -n 1
}

deploy_worker() {
  info "Deploying Worker..."
  local output
  output="$(cd "$PANEL_ROOT" && bunx wrangler deploy -c apps/server/wrangler.jsonc 2>&1)"
  printf '%s\n' "$output"
  LAST_WORKER_URL="$(printf '%s\n' "$output" | extract_worker_url)"
}

print_status() {
  local mode="$1"
  printf '\n\033[1;32m%s complete.\033[0m\n' "$mode"
  printf 'Project: snell-panel\n'
  printf 'Wrangler config: apps/server/wrangler.jsonc\n'
  printf 'D1 database_id: %s\n' "$(current_database_id)"
  printf 'Migrations: applied remotely\n'
  printf 'Secrets: ACCESS_TOKEN/API_TOKEN configured remotely (values are not readable from Cloudflare)\n'
  if [[ -n "${SNELL_PANEL_ACCESS_TOKEN:-}" ]]; then
    printf 'Generated/entered ACCESS_TOKEN: %s\n' "$SNELL_PANEL_ACCESS_TOKEN"
  fi
  if [[ -n "${SNELL_PANEL_API_TOKEN:-}" ]]; then
    printf 'Generated/entered API_TOKEN: %s\n' "$SNELL_PANEL_API_TOKEN"
  fi
  if [[ -n "$LAST_WORKER_URL" ]]; then
    printf 'Worker URL: %s\n' "$LAST_WORKER_URL"
  else
    printf 'Worker URL: check the Wrangler deploy output above.\n'
  fi
}
