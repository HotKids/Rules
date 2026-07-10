#!/usr/bin/env bash

PROJECT_NAME="snell-panel"
PANEL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$PANEL_ROOT/apps/server"
WRANGLER_CONFIG="$SERVER_DIR/wrangler.jsonc"
PLACEHOLDER_DB_ID="replace-with-your-d1-database-id"
LAST_WORKER_URL=""
SHOW_SECRETS=0
HEALTH_CHECK_RESULT="not run"

info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[DONE]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
fail() { error "$*"; exit 1; }

on_error() {
  local exit_code=$?
  error "Deployment step failed with exit code ${exit_code}. The command output above contains the complete Wrangler/Bun error. Fix it and rerun the script."
  exit "$exit_code"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

parse_common_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --show-secrets) SHOW_SECRETS=1 ;;
      -h|--help)
        cat <<HELP
Usage: $0 [--show-secrets]

--show-secrets  Print full generated/entered tokens in the final summary.
HELP
        exit 0
        ;;
      *) fail "Unknown option: $1" ;;
    esac
    shift
  done
}

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

run_cmd() {
  local output status
  info "Running: $*"
  set +e
  output="$($@ 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  if [[ "$status" -ne 0 ]]; then
    error "Command failed: $*"
    return "$status"
  fi
}

require_project() {
  [[ -d "$SERVER_DIR" ]] || fail "apps/server not found. Keep these scripts inside Rules/snell-panel."
  [[ -f "$WRANGLER_CONFIG" ]] || fail "Missing apps/server/wrangler.jsonc."
}

install_with_apt() {
  local package="$1"
  command_exists sudo || fail "sudo is required to install $package with apt. Install $package manually and rerun."
  run_cmd sudo apt-get update
  run_cmd sudo apt-get install -y "$package"
}

install_with_brew() {
  local package="$1"
  command_exists brew || fail "Homebrew is not installed. Install $package manually and rerun."
  run_cmd brew install "$package"
}

ensure_git() {
  if command_exists git; then success "git: $(git --version)"; return; fi
  warn "git is not installed."
  case "$(uname -s)" in
    Linux) command_exists apt-get && install_with_apt git || fail "Only apt-based Debian/Ubuntu Linux is supported for automatic git installation." ;;
    Darwin) command_exists brew && install_with_brew git || fail "Install git with Homebrew or run: xcode-select --install" ;;
    *) fail "Unsupported OS. Supported: Debian, Ubuntu, macOS." ;;
  esac
}

ensure_bun() {
  if command_exists bun; then success "bun: $(bun --version)"; return; fi
  warn "bun is not installed."
  case "$(uname -s)" in
    Linux|Darwin)
      command_exists curl || fail "curl is required to install bun."
      run_cmd bash -c 'curl -fsSL https://bun.sh/install | bash'
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      command_exists bun || fail "bun installed, but is not on PATH. Add $BUN_INSTALL/bin to PATH and rerun."
      ;;
    *) fail "Unsupported OS. Supported: Debian, Ubuntu, macOS." ;;
  esac
}

ensure_node() { if command_exists node; then success "node: $(node --version)"; else fail "node is required by Wrangler. Install Node.js 20+ and rerun."; fi; }
ensure_curl() { if command_exists curl; then success "curl: installed"; else fail "curl is required. Install curl and rerun."; fi; }
ensure_openssl() { if command_exists openssl; then success "openssl: $(openssl version | awk '{print $1, $2}')"; else warn "openssl is missing; token generation will use a weaker fallback."; fi; }
ensure_wrangler() { info "Checking Wrangler availability via bunx..."; wrangler --version >/dev/null; success "wrangler: available"; }
ensure_runtime_tools() { ensure_git; ensure_bun; ensure_node; ensure_curl; ensure_openssl; ensure_wrangler; }
install_dependencies() { info "Installing Bun workspace dependencies..."; (cd "$PANEL_ROOT" && run_cmd bun install); }

wrangler() { (cd "$SERVER_DIR" && bunx wrangler "$@"); }
wrangler_with_config() { (cd "$PANEL_ROOT" && bunx wrangler "$@" -c apps/server/wrangler.jsonc); }

is_headless() { [[ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" || -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; }

ensure_wrangler_login() {
  info "Validating Cloudflare Wrangler authentication with 'wrangler whoami'..."
  if wrangler whoami; then success "Wrangler authentication is valid."; return; fi
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    fail "CLOUDFLARE_API_TOKEN is set but 'wrangler whoami' failed. Check the token permissions."
  fi
  if is_headless; then
    warn "Detected a headless SSH/no-GUI environment. Wrangler OAuth may print a URL and wait for a browser callback."
    cat <<'MSG'
Recommended non-interactive option:
  export CLOUDFLARE_API_TOKEN=<token with Workers, D1, and Account read permissions>
  ./deploy.sh

If you continue with OAuth:
  1. Copy the authorization URL printed by Wrangler into your local browser.
  2. Complete authorization while keeping this SSH session open.
  3. If Wrangler shows a localhost callback URL, copy the FULL redirected URL and follow Wrangler's prompt.
MSG
  fi
  run_cmd wrangler login
  wrangler whoami >/dev/null || fail "Wrangler login did not produce a valid authenticated session."
  success "Wrangler authentication is valid."
}

current_database_id() {
  # Read the first database_id from apps/server/wrangler.jsonc. The key is a
  # quoted JSON key ("database_id":), so allow an optional closing quote between
  # the name and the `:`/`=` — otherwise the pattern never matches JSON and the
  # configured id is silently reported as missing. Placeholder filtering is left
  # to has_database_id().
  node - "$WRANGLER_CONFIG" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const ids = [...text.matchAll(/database_id["']?\s*[:=]\s*["']([^"']+)["']/g)]
  .map((m) => m[1])
  .filter(Boolean);
console.log(ids[0] || "");
NODE
}

current_database_name() {
  sed -nE 's/.*"database_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$WRANGLER_CONFIG" | head -n 1
}

has_database_id() { local database_id; database_id="$(current_database_id)"; [[ -n "$database_id" && "$database_id" != "$PLACEHOLDER_DB_ID" ]]; }

write_database_id() {
  local database_id="$1"
  [[ -n "$database_id" ]] || fail "database_id cannot be empty."
  DATABASE_ID="$database_id" perl -0pi -e 's/("database_id"\s*:\s*")[^"]*(")/$1$ENV{DATABASE_ID}$2/s' "$WRANGLER_CONFIG"
  [[ "$(current_database_id)" == "$database_id" ]] || fail "Failed to write database_id into apps/server/wrangler.jsonc."
  success "database_id saved to apps/server/wrangler.jsonc."
}

extract_database_id() { sed -nE 's/.*database_id[[:space:]]*=[[:space:]]*"?([0-9a-fA-F-]{20,})"?.*/\1/p; s/.*"database_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1; }

ensure_d1_database() {
  if has_database_id; then success "D1 database configured: $(current_database_id)"; return; fi
  warn "No usable D1 database_id is configured."
  if confirm "Reuse an existing D1 database_id?" "N"; then local manual_id; read -r -p "Existing D1 database_id: " manual_id; write_database_id "$manual_id"; return; fi
  info "Creating D1 database '$PROJECT_NAME' from apps/server..."
  local output status database_id
  set +e; output="$(wrangler d1 create "$PROJECT_NAME" 2>&1)"; status=$?; set -e
  printf '%s\n' "$output"
  if [[ "$status" -ne 0 ]]; then
    warn "D1 creation failed. This usually means the database already exists or the account lacks permission."
    read -r -p "Paste an existing D1 database_id to continue, or leave empty to abort: " database_id
    [[ -n "$database_id" ]] || fail "No D1 database_id provided."
    write_database_id "$database_id"; return
  fi
  database_id="$(printf '%s\n' "$output" | extract_database_id)"
  [[ -n "$database_id" ]] || fail "Could not parse database_id from Wrangler output. Paste it into apps/server/wrangler.jsonc and rerun."
  write_database_id "$database_id"
}

apply_remote_migrations() { info "Applying remote D1 migrations from apps/server..."; run_cmd wrangler d1 migrations apply "$PROJECT_NAME" --remote; }

generate_token() { if command_exists openssl; then openssl rand -hex 24; elif [[ -r /proc/sys/kernel/random/uuid ]]; then printf '%s%s\n' "$(cat /proc/sys/kernel/random/uuid | tr -d -)" "$(cat /proc/sys/kernel/random/uuid | tr -d -)" | cut -c 1-48; elif command_exists shasum; then printf '%s-%s\n' "$(date +%s%N)" "$RANDOM" | shasum -a 256 | awk '{print substr($1, 1, 48)}'; else printf '%s%s%s\n' "$(date +%s)" "$RANDOM" "$RANDOM"; fi; }
mask_secret() { local value="$1"; local len=${#value}; (( len <= 4 )) && printf '********' || printf '************%s' "${value: -4}"; }

read_secret_value() { local name="$1" value=""; if confirm "Auto-generate $name?" "Y"; then value="$(generate_token)"; printf '\033[1;32m[DONE]\033[0m %s generated automatically. It will be masked in the final summary unless --show-secrets is used.\n' "$name" >&2; else read -r -s -p "Enter $name: " value; printf '\n'; fi; [[ -n "$value" ]] || fail "$name cannot be empty."; printf '%s' "$value"; }
put_secret() { local name="$1" value="$2"; info "Uploading secret $name from apps/server..."; printf '%s' "$value" | wrangler secret put "$name"; }
configure_secrets() { local access_token api_token; access_token="$(read_secret_value ACCESS_TOKEN)"; api_token="$(read_secret_value API_TOKEN)"; put_secret ACCESS_TOKEN "$access_token"; put_secret API_TOKEN "$api_token"; export SNELL_PANEL_ACCESS_TOKEN="$access_token" SNELL_PANEL_API_TOKEN="$api_token"; }
build_panel() { info "Building web frontend..."; (cd "$PANEL_ROOT" && run_cmd bun run build); }
extract_worker_url() { sed -nE 's#.*(https://[^[:space:]]+\.workers\.dev).*#\1#p; s#.*(https://[^[:space:]]+)#\1#p' | tail -n 1; }
deploy_worker() { info "Deploying Worker..."; local output status; set +e; output="$(cd "$PANEL_ROOT" && bunx wrangler deploy -c apps/server/wrangler.jsonc 2>&1)"; status=$?; set -e; printf '%s\n' "$output"; [[ "$status" -eq 0 ]] || return "$status"; LAST_WORKER_URL="$(printf '%s\n' "$output" | extract_worker_url)"; }

health_check_worker() {
  local url="${1:-$LAST_WORKER_URL}" headers body status content_type
  [[ -n "$url" ]] || { warn "Skipping health check because Worker URL could not be detected."; HEALTH_CHECK_RESULT="skipped: missing Worker URL"; return 0; }
  info "Running deployment health check: $url"
  headers="$(mktemp)"; body="$(mktemp)"
  status="$(curl -L -sS -D "$headers" -o "$body" -w '%{http_code}' "$url" || true)"
  content_type="$(awk 'BEGIN{IGNORECASE=1}/^content-type:/{sub(/\r$/,"",$0); print $0; exit}' "$headers")"
  case "$status" in
    2*|3*) ;;
    *)
      cat "$body"
      rm -f "$headers" "$body"
      HEALTH_CHECK_RESULT="failed: HTTP $status"
      fail "Worker health check failed with HTTP $status."
      ;;
  esac
  if grep -qi "There is nothing here yet" "$body"; then cat "$body"; rm -f "$headers" "$body"; HEALTH_CHECK_RESULT="failed: default empty Worker page"; fail "Worker deployed but Cloudflare returned the default empty Worker page."; fi
  if ! grep -Eqi '<html|<!doctype|id="root"|application/json|text/html' "$body" "$headers"; then warn "Health check succeeded with HTTP $status, but response did not look like the SPA shell."; fi
  HEALTH_CHECK_RESULT="ok: HTTP $status ${content_type}"
  rm -f "$headers" "$body"
  success "Worker health check passed ($HEALTH_CHECK_RESULT)."
}

print_token_line() { local name="$1" value="$2"; if [[ "$SHOW_SECRETS" -eq 1 ]]; then printf '%s: %s\n' "$name" "$value"; else printf '%s: %s (use --show-secrets to print full value)\n' "$name" "$(mask_secret "$value")"; fi; }

print_status() {
  local mode="$1" worker_url="${LAST_WORKER_URL:-}"
  printf '\n\033[1;32m%s complete.\033[0m\n' "$mode"
  printf 'Project: snell-panel\nWrangler config: apps/server/wrangler.jsonc\nD1 database_id: %s\n' "$(current_database_id)"
  [[ -n "$worker_url" ]] && printf 'Worker URL: %s\nAPI Base URL: %s/api\n' "$worker_url" "$worker_url" || printf 'Worker URL: check the Wrangler deploy output above.\n'
  printf 'Migrations: applied remotely\nSecrets: ACCESS_TOKEN/API_TOKEN configured remotely (Cloudflare secrets are write-only)\nHealth check: %s\n' "$HEALTH_CHECK_RESULT"
  [[ -n "${SNELL_PANEL_ACCESS_TOKEN:-}" ]] && print_token_line ACCESS_TOKEN "$SNELL_PANEL_ACCESS_TOKEN"
  [[ -n "${SNELL_PANEL_API_TOKEN:-}" ]] && print_token_line API_TOKEN "$SNELL_PANEL_API_TOKEN"
  [[ -n "$worker_url" ]] && printf 'Admin login: open %s and sign in with ACCESS_TOKEN.\n' "$worker_url"
  cat <<'NEXT'
Next commands:
  Update:   ./update.sh
  Redeploy: bun run build && bunx wrangler deploy -c apps/server/wrangler.jsonc
  Logs:     cd apps/server && bunx wrangler tail
  Doctor:   ./doctor.sh
NEXT
}
