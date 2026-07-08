#!/usr/bin/env bash
#
# snell-panel installer — driven by the panel's generated command.
#
# Subcommands:
#   install     Install a snell-server (V5 or V6) and register it with the panel.
#   uninstall   Stop + remove the service; optionally delete the panel entry.
#   upgrade     Migrate an existing V4/V5 node to V6 in place (config + binary),
#               then re-report to the panel.
#
# Flags:
#   --api-url URL        Panel base URL (e.g. https://panel.example.com)
#   --node-id ID         Panel node id (uuid)
#   --token TOKEN        One-time install/upgrade token (from the panel)
#   --api-token TOKEN    Master API token (optional; lets uninstall delete the panel entry)
#   --version 5|6        Target Snell protocol version
#   --snell-version VER  Exact binary build, e.g. v6.0.0b4 (defaults per family)
#   --ip HOST            Pre-filled public IP/host to register (skips auto-detect)
#   --port PORT          Fixed listen port (skips random)
#   --name NAME          Optional; only used in the local install summary. The
#                        panel owns the node name, so it is not sent on register.
#   --variant V          official | opensnell  (default official; opensnell is V5-only)
#
# Modeled on github.com/missuo/opensnell install.sh.

set -uo pipefail

# ----------------------------------------------------------------------------
# Pretty-printing
# ----------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
print_header()  { echo; echo -e "${BOLD}${BLUE}== $1 ==${NC}"; }
print_success() { echo -e "${GREEN}[OK]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_info()    { echo -e "${CYAN}[INFO]${NC} $1"; }

# ----------------------------------------------------------------------------
# Constants / paths
# ----------------------------------------------------------------------------
INSTALL_BIN="/usr/local/bin/snell-server"
CONFIG_DIR="/etc/snell"
CONFIG_FILE="$CONFIG_DIR/snell-server.conf"
META_FILE="$CONFIG_DIR/.install_meta"
SERVICE_NAME="snell-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

OPENSNELL_REPO="missuo/opensnell"
OPENSNELL_RELEASE_API="https://api.github.com/repos/${OPENSNELL_REPO}/releases/latest"
DEFAULT_SURGE_V5="v5.0.1"
DEFAULT_SURGE_V6="v6.0.0b4"
SURGE_BASE_URL="https://dl.nssurge.com/snell"

# ----------------------------------------------------------------------------
# Flags
# ----------------------------------------------------------------------------
ACTION="${1:-}"; [ $# -gt 0 ] && shift
API_URL=""; NODE_ID=""; TOKEN=""; API_TOKEN=""
VERSION=""; SNELL_VERSION=""; PREFILL_IP=""; PREFILL_PORT=""; NODE_NAME=""
VARIANT="official"

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url)       API_URL="${2:-}"; shift 2 ;;
    --node-id)       NODE_ID="${2:-}"; shift 2 ;;
    --token)         TOKEN="${2:-}"; shift 2 ;;
    --api-token)     API_TOKEN="${2:-}"; shift 2 ;;
    --version)       VERSION="${2:-}"; shift 2 ;;
    --snell-version) SNELL_VERSION="${2:-}"; shift 2 ;;
    --ip)            PREFILL_IP="${2:-}"; shift 2 ;;
    --port)          PREFILL_PORT="${2:-}"; shift 2 ;;
    --name)          NODE_NAME="${2:-}"; shift 2 ;;
    --variant)       VARIANT="${2:-}"; shift 2 ;;
    -h|--help)       show_help; exit 0 ;;
    *) print_error "Unknown option: $1"; exit 1 ;;
  esac
done

# Runtime values filled during an action.
PORT=""; PSK=""; REPORT_IP=""; PSK_CHANGED=0

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
show_help() {
  sed -n '2,30p' "$0" 2>/dev/null || echo "Usage: $0 {install|uninstall|upgrade} [flags]"
}

check_root() {
  [ "$(id -u)" -eq 0 ] || { print_error "Please run as root."; exit 1; }
}

ensure_tools() {
  local missing=() pkg
  for pkg in curl unzip openssl; do
    command -v "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  print_info "Installing dependencies: ${missing[*]}"
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y "${missing[@]}"
  elif command -v dnf >/dev/null 2>&1;     then dnf install -y "${missing[@]}"
  elif command -v yum >/dev/null 2>&1;     then yum install -y "${missing[@]}"
  elif command -v pacman >/dev/null 2>&1;  then pacman -Sy --noconfirm "${missing[@]}"
  elif command -v zypper >/dev/null 2>&1;  then zypper install -y "${missing[@]}"
  else print_error "Install these manually: ${missing[*]}"; exit 1; fi
}

detect_arch_surge() {
  case "$(uname -m)" in
    x86_64)        echo amd64 ;;
    aarch64|arm64) echo aarch64 ;;
    i386|i686)     echo i386 ;;
    armv7l|armv7)  echo armv7l ;;
    *)             echo unsupported ;;
  esac
}

detect_arch_opensnell() {
  case "$(uname -m)" in
    x86_64)        echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    i386|i686)     echo 386 ;;
    armv7l|armv7)  echo armv7 ;;
    *)             echo unsupported ;;
  esac
}

# A 32-char alphanumeric PSK (per Snell's official recommendation, safe in configs/URLs).
gen_psk() { openssl rand -base64 48 | tr -d '/+=' | cut -c1-32; }

# v6 requires a PSK of 16..255 bytes.
psk_len_ok() {
  local n; n=$(printf '%s' "$1" | wc -c | tr -d ' ')
  [ "$n" -ge 16 ] && [ "$n" -le 255 ]
}

resolve_snell_version() {
  [ -n "$SNELL_VERSION" ] && return 0
  if [ "$VERSION" = "6" ]; then SNELL_VERSION="$DEFAULT_SURGE_V6"; else SNELL_VERSION="$DEFAULT_SURGE_V5"; fi
}

pick_free_port() {
  local p i
  for i in $(seq 1 25); do
    p=$(shuf -i 20000-59999 -n 1)
    if ! ss -ltn 2>/dev/null | grep -q ":${p}[[:space:]]"; then echo "$p"; return; fi
  done
  shuf -i 20000-59999 -n 1
}

detect_public_ip() {
  local url ip
  for url in "https://api.ip.sb/ip" "https://ipinfo.io/ip" "https://api.ipify.org"; do
    ip=$(curl -fsS4 -m 8 "$url" 2>/dev/null | tr -d '[:space:]')
    [ -n "$ip" ] && { echo "$ip"; return 0; }
  done
  return 1
}

enable_tfo() {
  local setting="net.ipv4.tcp_fastopen = 3" conf="/etc/sysctl.conf"
  if grep -q "^net.ipv4.tcp_fastopen" "$conf" 2>/dev/null; then
    sed -i "s/^net.ipv4.tcp_fastopen.*/${setting}/" "$conf"
  else
    echo "$setting" >> "$conf"
  fi
  sysctl -p >/dev/null 2>&1 || true
}

meta_get() { [ -f "$META_FILE" ] && grep "^$1=" "$META_FILE" | head -1 | cut -d= -f2- || true; }

# ----------------------------------------------------------------------------
# Binary download
# ----------------------------------------------------------------------------
download_surge() {
  local version="$1" arch url tmp
  arch=$(detect_arch_surge)
  [ "$arch" = unsupported ] && { print_error "Unsupported architecture: $(uname -m)"; exit 1; }
  case "$version" in
    v6*) [ "$arch" = armv7l ] && { print_error "Surge snell-server $version has no armv7l build."; exit 1; } ;;
  esac
  url="${SURGE_BASE_URL}/snell-server-${version}-linux-${arch}.zip"
  print_info "Downloading Surge snell-server ${version} (linux-${arch})"
  mkdir -p "$CONFIG_DIR"
  tmp=$(mktemp -d)
  curl -fL --progress-bar -o "$tmp/snell.zip" "$url" || { rm -rf "$tmp"; print_error "Download failed: $url"; exit 1; }
  unzip -q -o "$tmp/snell.zip" -d "$tmp"
  install -m 0755 "$tmp/snell-server" "$INSTALL_BIN"
  rm -rf "$tmp"
}

download_opensnell() {
  local arch tag url tmp
  arch=$(detect_arch_opensnell)
  [ "$arch" = unsupported ] && { print_error "Unsupported architecture: $(uname -m)"; exit 1; }
  tag=$(curl -fsSL "$OPENSNELL_RELEASE_API" | grep '"tag_name":' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
  [ -z "$tag" ] && { print_error "Could not resolve the latest OpenSnell release."; exit 1; }
  url="https://github.com/${OPENSNELL_REPO}/releases/download/${tag}/snell-server-linux-${arch}"
  print_info "Downloading OpenSnell ${tag} (linux-${arch})"
  mkdir -p "$CONFIG_DIR"
  tmp=$(mktemp)
  curl -fL --progress-bar -o "$tmp" "$url" || { rm -f "$tmp"; print_error "Download failed: $url"; exit 1; }
  install -m 0755 "$tmp" "$INSTALL_BIN"
  rm -f "$tmp"
  SNELL_VERSION="$tag"
}

download_binary() {
  if [ "$VARIANT" = "opensnell" ]; then
    [ "$VERSION" = "6" ] && { print_error "The opensnell variant supports V5 only; use official for V6."; exit 1; }
    download_opensnell
  else
    download_surge "$SNELL_VERSION"
  fi
}

# ----------------------------------------------------------------------------
# Config + service
# ----------------------------------------------------------------------------
write_config() {
  mkdir -p "$CONFIG_DIR"
  if [ "$VERSION" = "6" ]; then
    # v6: obfs removed, ipv6 replaced by dns-ip-preference.
    cat > "$CONFIG_FILE" <<EOF
[snell-server]
listen = 0.0.0.0:${PORT}
psk = ${PSK}
dns-ip-preference = default
EOF
  else
    cat > "$CONFIG_FILE" <<EOF
[snell-server]
listen = 0.0.0.0:${PORT}
psk = ${PSK}
ipv6 = false
EOF
  fi
  chmod 600 "$CONFIG_FILE"
}

# Migrate an existing V4/V5 config to V6 in place: drop keys removed in v6,
# regenerate the PSK if it is non-compliant, and ensure dns-ip-preference.
migrate_config_to_v6() {
  local tmp; tmp=$(mktemp)
  grep -viE '^[[:space:]]*(obfs|obfs-opts|ipv6|dns-ip-preference)[[:space:]]*=' "$CONFIG_FILE" > "$tmp"
  if [ "$PSK_CHANGED" = "1" ]; then
    sed -i -E "s|^[[:space:]]*psk[[:space:]]*=.*|psk = ${PSK}|" "$tmp"
  fi
  if ! grep -qiE '^[[:space:]]*dns-ip-preference[[:space:]]*=' "$tmp"; then
    printf 'dns-ip-preference = default\n' >> "$tmp"
  fi
  install -m 600 "$tmp" "$CONFIG_FILE"
  rm -f "$tmp"
}

write_systemd_unit() {
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Snell server
After=network.target

[Service]
Type=simple
ExecStart=${INSTALL_BIN} -c ${CONFIG_FILE}
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

save_meta() {
  mkdir -p "$CONFIG_DIR"
  cat > "$META_FILE" <<EOF
variant=${VARIANT}
version=${VERSION}
snell_version=${SNELL_VERSION}
port=${PORT}
psk=${PSK}
node_id=${NODE_ID}
api_url=${API_URL}
report_ip=${REPORT_IP}
EOF
  chmod 600 "$META_FILE"
}

# ----------------------------------------------------------------------------
# Panel callbacks
# ----------------------------------------------------------------------------
# Pre-flight: abort before doing any install work if the one-time token is
# already invalid/expired, so we never install only to fail the callback later.
verify_token() {
  command -v curl >/dev/null 2>&1 || return 0           # can't check yet; register will gate
  [ -n "$API_URL" ] && [ -n "$NODE_ID" ] && [ -n "$TOKEN" ] || return 0
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    "${API_URL}/api/nodes/${NODE_ID}/verify-token?token=${TOKEN}" 2>/dev/null || echo "000")
  [ "$code" = "000" ] && return 0                        # network blip; let register decide
  if [ "$code" != "200" ]; then
    print_error "Install token is invalid or expired (HTTP ${code})."
    print_info "Generate a fresh command from the panel and run it within 5 minutes."
    exit 1
  fi
  print_success "Install token verified."
}

# Report ip/port/psk/version to the panel (consumes the one-time token).
# Returns curl's exit status so the caller can gate on it.
register_with_panel() {
  [ -n "$API_URL" ] && [ -n "$NODE_ID" ] && [ -n "$TOKEN" ] || return 0
  local ipfield=""
  [ -n "$REPORT_IP" ] && ipfield=",\"ip\":\"${REPORT_IP}\""
  local data="{\"port\":${PORT},\"psk\":\"${PSK}\",\"version\":\"${VERSION}\"${ipfield}}"
  curl -fsS -X POST "${API_URL}/api/nodes/${NODE_ID}/register?token=${TOKEN}" \
    -H "Content-Type: application/json" -d "$data" >/dev/null 2>&1
}

delete_from_panel() {
  [ -n "$API_URL" ] && [ -n "$NODE_ID" ] || return 0
  local tok="${API_TOKEN:-$TOKEN}"
  [ -n "$tok" ] || { print_info "No token given; delete the node in the panel manually."; return 0; }
  if curl -fsS -X DELETE "${API_URL}/api/nodes/${NODE_ID}?token=${tok}" >/dev/null; then
    print_success "Deleted the node from the panel."
  else
    print_warning "Could not delete the panel entry; remove it manually."
  fi
}

print_summary() {
  print_header "Done"
  echo "  Variant:        ${VARIANT}"
  echo "  Snell version:  ${VERSION} (${SNELL_VERSION})"
  echo "  Listen port:    ${PORT}"
  echo "  PSK:            ${PSK}"
  [ -n "$REPORT_IP" ] && echo "  Reported IP:    ${REPORT_IP}"
  [ -n "$REPORT_IP" ] && echo "  Surge line:     ${NODE_NAME:-Snell} = snell, ${REPORT_IP}, ${PORT}, psk = ${PSK}, version = ${VERSION}, tfo = true"
}

require() { [ -n "$2" ] || { print_error "Missing required flag: $1"; exit 1; }; }

# ----------------------------------------------------------------------------
# Actions
# ----------------------------------------------------------------------------
do_install() {
  check_root
  require --api-url "$API_URL"; require --node-id "$NODE_ID"
  require --token "$TOKEN";     require --version "$VERSION"
  verify_token            # fail fast on an already-expired token, before anything else
  ensure_tools
  resolve_snell_version

  # Compute the connection details first (fast: random/prefill port, PSK, public IP)
  # so we can register them while the one-time token is still fresh.
  if [ -n "$PREFILL_PORT" ]; then PORT="$PREFILL_PORT"; else PORT="$(pick_free_port)"; fi
  PSK="$(gen_psk)"
  if [ "$VERSION" = "6" ] && ! psk_len_ok "$PSK"; then print_error "Generated PSK invalid for v6."; exit 1; fi
  if [ -n "$PREFILL_IP" ]; then REPORT_IP="$PREFILL_IP"; else REPORT_IP="$(detect_public_ip || true)"; fi

  # Register FIRST — the token is consumed here, seconds into the run, so the slow
  # binary download/setup below never races the 5-minute expiry. Abort if it fails.
  print_info "Registering node with the panel..."
  if ! register_with_panel; then
    print_error "Could not register with the panel — the install token is expired/invalid (or the panel is unreachable)."
    print_info "Generate a fresh command from the panel and run it within 5 minutes. Nothing was installed."
    exit 1
  fi
  print_success "Node registered. Installing snell-server (this can take a moment)..."

  print_header "Installing Snell V${VERSION}"
  download_binary
  write_config
  enable_tfo
  write_systemd_unit
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
  sleep 1
  systemctl is-active --quiet "$SERVICE_NAME" \
    || print_warning "Service not active; check 'journalctl -u ${SERVICE_NAME} -n 30'."
  save_meta
  print_summary
}

do_uninstall() {
  check_root
  print_header "Uninstalling Snell"
  [ -z "$NODE_ID" ] && NODE_ID="$(meta_get node_id)"
  [ -z "$API_URL" ] && API_URL="$(meta_get api_url)"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"; systemctl daemon-reload
  rm -f "$INSTALL_BIN"
  rm -rf "$CONFIG_DIR"
  print_success "Removed service, binary and config."
  delete_from_panel
}

do_upgrade() {
  check_root
  ensure_tools
  [ -f "$CONFIG_FILE" ] || { print_error "No existing config at ${CONFIG_FILE}; nothing to upgrade."; exit 1; }
  VERSION="${VERSION:-6}"
  [ "$VERSION" = "6" ] || { print_error "Upgrade only targets V6."; exit 1; }
  [ -z "$API_URL" ] && API_URL="$(meta_get api_url)"
  [ -z "$NODE_ID" ] && NODE_ID="$(meta_get node_id)"
  [ "$VARIANT" = "official" ] && [ -n "$(meta_get variant)" ] && VARIANT="$(meta_get variant)"
  [ "$VARIANT" = "opensnell" ] && VARIANT="official"   # OpenSnell here is V5-only; use Surge for V6
  resolve_snell_version
  verify_token   # abort early on an expired/invalid token, before migrating anything

  PORT="$(grep -E '^[[:space:]]*listen' "$CONFIG_FILE" | head -1 | sed -E 's/.*:([0-9]+).*/\1/')"
  PSK="$(grep -E '^[[:space:]]*psk' "$CONFIG_FILE" | head -1 | cut -d= -f2- | tr -d ' ')"
  REPORT_IP="$(meta_get report_ip)"

  print_header "Upgrading to Snell V6"
  if ! psk_len_ok "$PSK"; then
    print_warning "Existing PSK is not valid for V6 (needs 16-255 bytes); generating a new one."
    PSK="$(gen_psk)"; PSK_CHANGED=1
  fi

  migrate_config_to_v6
  print_success "Config migrated to V6 (removed obfs/ipv6, set dns-ip-preference)."

  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  download_binary
  write_systemd_unit
  systemctl start "$SERVICE_NAME"
  sleep 1
  systemctl is-active --quiet "$SERVICE_NAME" \
    || print_warning "Service not active after upgrade; check 'journalctl -u ${SERVICE_NAME} -n 30'."

  save_meta
  if [ -n "$TOKEN" ]; then
    if register_with_panel; then
      [ "$PSK_CHANGED" = "1" ] \
        && print_success "Re-reported to the panel (version 6, new PSK)." \
        || print_success "Re-reported to the panel (version 6)."
    else
      print_warning "Failed to re-report to the panel; update the node there manually."
    fi
  else
    print_info "No --token provided; re-report to the panel skipped."
    [ "$PSK_CHANGED" = "1" ] && print_warning "PSK changed — update the panel so subscriptions stay valid."
  fi
  print_summary
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
case "$ACTION" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  upgrade)   do_upgrade ;;
  ""|-h|--help|help) show_help ;;
  *) print_error "Unknown command: $ACTION"; show_help; exit 1 ;;
esac
