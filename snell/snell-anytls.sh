#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ANYTLS_DIR="/etc/AnyTLS"
ANYTLS_BIN="/etc/AnyTLS/server"
ANYTLS_CONFIG="/etc/AnyTLS/config.yaml"
ANYTLS_CLIENT="/etc/AnyTLS/client.txt"
ANYTLS_SERVICE="/etc/systemd/system/anytls.service"
ANYTLS_SERVICE_NAME="anytls.service"
SNELL_DIR="/etc/snell"
SNELL_BIN="/usr/local/bin/snell-server"
SNELL_CONFIG="/etc/snell/snell-server.conf"
SNELL_SERVICE="/etc/systemd/system/snell.service"
SNELL_META="/etc/snell/version"
SHADOWTLS_DIR="/etc/shadowtls"
SHADOWTLS_BIN="/usr/local/bin/shadow-tls"
SHADOWTLS_CONFIG="/etc/shadowtls/config.env"
SHADOWTLS_SERVICE="/etc/systemd/system/shadowtls.service"

msg(){ printf "%b\n" "$1"; }
ok(){ msg "${GREEN}$1${NC}"; }
warn(){ msg "${YELLOW}$1${NC}"; }
err(){ msg "${RED}$1${NC}" >&2; }
need_root(){ if [[ "${EUID}" -ne 0 ]]; then err "请使用 root 权限运行。"; exit 1; fi; }
has(){ command -v "$1" >/dev/null 2>&1; }
pause(){ read -r -p "按回车继续..." _ || true; }

install_deps(){
  local deps=(curl wget unzip tar jq openssl ca-certificates git sed awk coreutils)
  if has apt-get; then apt-get update -y; DEBIAN_FRONTEND=noninteractive apt-get install -y "${deps[@]}" iproute2 || true
  elif has dnf; then dnf install -y "${deps[@]}" iproute || true
  elif has yum; then yum install -y "${deps[@]}" iproute || true
  else err "未找到 apt/dnf/yum，请手动安装依赖：${deps[*]}"; return 1; fi
}

check_system(){
  if [[ ! -r /etc/os-release ]]; then err "无法识别系统。"; return 1; fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in debian|ubuntu|centos|rhel|almalinux|rocky) ok "系统：${PRETTY_NAME:-${ID}}";; *) warn "未明确适配的系统：${PRETTY_NAME:-${ID:-unknown}}，继续尝试。";; esac
}

backup_file(){ local f="$1" ts; ts="$(date +%Y%m%d-%H%M%S)"; [[ -e "$f" ]] && cp -a "$f" "${f}.bak.${ts}"; }
yaml_get(){ local key="$1" file="$2"; [[ -f "$file" ]] || return 1; awk -F': *' -v k="$key" '$1==k{v=$0; sub("^[^:]+:[ ]*", "", v); gsub(/^\"|\"$/, "", v); print v; exit}' "$file"; }
yaml_quote(){ local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
json_quote_inner(){ local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '%s' "$v"; }
urlencode(){ jq -nr --arg v "$1" '$v|@uri'; }
random_port(){ shuf -i 2000-65000 -n 1; }
random_password(){ if has uuidgen; then uuidgen; else openssl rand -base64 24 | tr -d '\n'; fi; }
valid_port(){ [[ "$1" =~ ^[0-9]+$ ]] && (( "$1" >= 1 && "$1" <= 65535 )); }
port_in_use(){ local p="$1"; ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}$"; }

ask_port(){
  local prompt="$1" p
  while true; do
    read -r -p "${prompt}（回车随机）: " p || true
    [[ -z "$p" ]] && p="$(random_port)"
    if ! valid_port "$p"; then warn "端口必须为 1-65535。"; continue; fi
    if port_in_use "$p"; then warn "端口 ${p} 已被占用，请换一个。"; continue; fi
    printf '%s' "$p"; return 0
  done
}

get_public_addr(){
  local ip trace
  ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"; [[ -n "$ip" ]] && { printf '%s' "$ip"; return; }
  ip="$(curl -4fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"; [[ -n "$ip" ]] && { printf '%s' "$ip"; return; }
  trace="$(curl -4fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null || true)"; printf '%s' "$trace" | awk -F= '$1=="ip"{print $2; exit}'
}

allow_tcp_port(){
  local port="$1"
  if has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --add-port="${port}/tcp" --permanent >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && ok "已尝试通过 firewalld 放行 TCP ${port}。" && return; fi
  if has ufw && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "${port}/tcp" >/dev/null 2>&1 && ok "已尝试通过 ufw 放行 TCP ${port}。" && return; fi
  warn "请在 VPS 安全组、防火墙或云厂商控制台放行 TCP ${port}。"
}

anytls_arch(){ case "$(uname -m)" in x86_64|amd64) printf amd64;; aarch64|arm64) printf arm64;; *) err "AnyTLS 暂不支持当前架构：$(uname -m)"; return 1;; esac; }
anytls_latest(){ curl -fsSL https://api.github.com/repos/anytls/anytls-go/releases/latest | jq -r '.tag_name'; }

download_anytls(){
  local latest arch url zip
  latest="$(anytls_latest)"; [[ -n "$latest" && "$latest" != "null" ]] || { err "获取 AnyTLS 最新版本失败。"; return 1; }
  arch="$(anytls_arch)"; url="https://github.com/anytls/anytls-go/releases/download/${latest}/anytls_${latest#v}_linux_${arch}.zip"; zip="${TMP_DIR}/anytls.zip"
  ok "下载 AnyTLS ${latest} (${arch})"
  wget -O "$zip" "$url" || { err "下载失败：${url}"; return 1; }
  unzip -o "$zip" -d "${TMP_DIR}/anytls" >/dev/null
  [[ -f "${TMP_DIR}/anytls/anytls-server" ]] || { err "压缩包内未找到 anytls-server。"; return 1; }
  mkdir -p "$ANYTLS_DIR"; mv "${TMP_DIR}/anytls/anytls-server" "$ANYTLS_BIN"; chmod +x "$ANYTLS_BIN"; printf '%s' "$latest"
}

write_anytls_config(){
  local name="$1" server="$2" port="$3" password="$4" sni="$5" version="$6" created="$7"
  mkdir -p "$ANYTLS_DIR"
  cat > "$ANYTLS_CONFIG" <<EOC
name: $(yaml_quote "$name")
server: $(yaml_quote "$server")
port: ${port}
password: $(yaml_quote "$password")
sni: $(yaml_quote "$sni")
skip_cert_verify: true
service: "${ANYTLS_SERVICE_NAME}"
binary: "${ANYTLS_BIN}"
client_config: "${ANYTLS_CLIENT}"
created_at: $(yaml_quote "$created")
version: $(yaml_quote "$version")
EOC
}

write_anytls_service(){
  local port="$1" password="$2" escaped
  escaped="${password//\\/\\\\}"; escaped="${escaped//\"/\\\"}"
  cat > "$ANYTLS_SERVICE" <<EOS
[Unit]
Description=AnyTLS Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${ANYTLS_BIN} -l 0.0.0.0:${port} -p "${escaped}"
Restart=on-failure
RestartSec=10s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOS
}

load_anytls(){
  [[ -f "$ANYTLS_CONFIG" ]] || { err "AnyTLS 未安装或配置不存在。"; return 1; }
  AT_NAME="$(yaml_get name "$ANYTLS_CONFIG")"; AT_SERVER="$(yaml_get server "$ANYTLS_CONFIG")"; AT_PORT="$(yaml_get port "$ANYTLS_CONFIG")"
  AT_PASSWORD="$(yaml_get password "$ANYTLS_CONFIG")"; AT_SNI="$(yaml_get sni "$ANYTLS_CONFIG")"; AT_VERSION="$(yaml_get version "$ANYTLS_CONFIG")"
  AT_CREATED="$(yaml_get created_at "$ANYTLS_CONFIG")"
}

generate_anytls_client(){
  load_anytls
  local p_enc name_q pass_q sni_q uri surge mihomo
  p_enc="$(urlencode "$AT_PASSWORD")"; name_q="$(json_quote_inner "$AT_NAME")"; pass_q="$(json_quote_inner "$AT_PASSWORD")"; sni_q="$(json_quote_inner "$AT_SNI")"
  uri="anytls://${p_enc}@${AT_SERVER}:${AT_PORT}"
  surge="${AT_NAME} = anytls, ${AT_SERVER}, ${AT_PORT}, password=\"${pass_q}\", sni=\"${sni_q}\", skip-cert-verify=true, tfo=true"
  mihomo="- {name: \"${name_q}\", type: anytls, server: ${AT_SERVER}, port: ${AT_PORT}, password: \"${pass_q}\", client-fingerprint: chrome, udp: true, sni: \"${sni_q}\", skip-cert-verify: true}"
  cat > "$ANYTLS_CLIENT" <<EOC
节点名称:
${AT_NAME}

服务器地址:
${AT_SERVER}

端口:
${AT_PORT}

密码:
${AT_PASSWORD}

SNI:
${AT_SNI}

systemd 服务名:
${ANYTLS_SERVICE_NAME}

配置文件路径:
${ANYTLS_CONFIG}

客户端配置文件路径:
${ANYTLS_CLIENT}

AnyTLS URI:
${uri}

Surge:
${surge}

mihomo:
${mihomo}
EOC
  cat "$ANYTLS_CLIENT"
}

install_anytls(){
  need_root; check_system; install_deps
  if [[ -e "$ANYTLS_CONFIG" || -e "$ANYTLS_SERVICE" ]]; then warn "检测到旧 AnyTLS 配置，将先备份。"; fi
  backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; backup_file "$ANYTLS_SERVICE"
  local version port password sni name server auto created custom
  version="$(download_anytls)"
  port="$(ask_port "请输入 AnyTLS 端口")"
  custom=""; read -r -p "请输入 AnyTLS 密码（回车自动生成）: " custom || true; password="${custom:-$(random_password)}"
  read -r -p "请输入节点名称（回车 HK-AnyTLS）: " name || true; name="${name:-HK-AnyTLS}"
  read -r -p "请输入 SNI（回车 www.apple.com）: " sni || true; sni="${sni:-www.apple.com}"
  auto="$(get_public_addr)"; read -r -p "请输入服务器 IP 或域名（回车使用 ${auto:-手动输入}）: " server || true
  server="${server:-$auto}"; while [[ -z "$server" ]]; do read -r -p "服务器地址不能为空，请输入: " server || true; done
  created="$(date '+%Y-%m-%d %H:%M:%S')"
  write_anytls_config "$name" "$server" "$port" "$password" "$sni" "$version" "$created"
  write_anytls_service "$port" "$password"
  systemctl daemon-reload; systemctl enable --now "$ANYTLS_SERVICE_NAME"
  allow_tcp_port "$port"; generate_anytls_client
}

update_anytls(){
  need_root; install_deps; load_anytls; backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; backup_file "$ANYTLS_SERVICE"
  local version; version="$(download_anytls)"
  write_anytls_config "$AT_NAME" "$AT_SERVER" "$AT_PORT" "$AT_PASSWORD" "$AT_SNI" "$version" "${AT_CREATED:-$(date '+%Y-%m-%d %H:%M:%S')}"
  write_anytls_service "$AT_PORT" "$AT_PASSWORD"; systemctl daemon-reload; systemctl restart "$ANYTLS_SERVICE_NAME"; generate_anytls_client
}

change_anytls_port(){ need_root; load_anytls; backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; backup_file "$ANYTLS_SERVICE"; local p; p="$(ask_port "请输入新的 AnyTLS 端口")"; write_anytls_config "$AT_NAME" "$AT_SERVER" "$p" "$AT_PASSWORD" "$AT_SNI" "$AT_VERSION" "${AT_CREATED:-$(date '+%Y-%m-%d %H:%M:%S')}"; write_anytls_service "$p" "$AT_PASSWORD"; systemctl daemon-reload; systemctl restart "$ANYTLS_SERVICE_NAME"; allow_tcp_port "$p"; generate_anytls_client; }
change_anytls_password(){ need_root; load_anytls; backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; backup_file "$ANYTLS_SERVICE"; local p; read -r -p "请输入新密码（回车自动生成）: " p || true; p="${p:-$(random_password)}"; write_anytls_config "$AT_NAME" "$AT_SERVER" "$AT_PORT" "$p" "$AT_SNI" "$AT_VERSION" "${AT_CREATED:-$(date '+%Y-%m-%d %H:%M:%S')}"; write_anytls_service "$AT_PORT" "$p"; systemctl daemon-reload; systemctl restart "$ANYTLS_SERVICE_NAME"; generate_anytls_client; }
change_anytls_name(){ need_root; load_anytls; backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; local n; read -r -p "请输入新显示名称: " n || true; [[ -n "$n" ]] || { err "名称不能为空。"; return 1; }; write_anytls_config "$n" "$AT_SERVER" "$AT_PORT" "$AT_PASSWORD" "$AT_SNI" "$AT_VERSION" "${AT_CREATED:-$(date '+%Y-%m-%d %H:%M:%S')}"; generate_anytls_client; }
change_anytls_sni(){ need_root; load_anytls; backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; local s; read -r -p "请输入新 SNI（回车 www.apple.com）: " s || true; s="${s:-www.apple.com}"; write_anytls_config "$AT_NAME" "$AT_SERVER" "$AT_PORT" "$AT_PASSWORD" "$s" "$AT_VERSION" "${AT_CREATED:-$(date '+%Y-%m-%d %H:%M:%S')}"; generate_anytls_client; }
show_anytls(){ if [[ -f "$ANYTLS_CONFIG" ]]; then [[ -f "$ANYTLS_CLIENT" ]] || generate_anytls_client >/dev/null; cat "$ANYTLS_CLIENT"; else warn "AnyTLS 未安装。"; fi; }
uninstall_anytls(){ need_root; backup_file "$ANYTLS_CONFIG"; backup_file "$ANYTLS_CLIENT"; backup_file "$ANYTLS_SERVICE"; systemctl stop "$ANYTLS_SERVICE_NAME" 2>/dev/null || true; systemctl disable "$ANYTLS_SERVICE_NAME" 2>/dev/null || true; rm -f "$ANYTLS_SERVICE"; rm -rf "$ANYTLS_DIR"; systemctl daemon-reload; warn "已卸载 AnyTLS，请手动清理防火墙、安全组或云厂商控制台端口规则。"; }

snell_arch(){ case "$(uname -m)" in x86_64|amd64) printf amd64;; aarch64|arm64) printf aarch64;; *) err "Snell 暂不支持当前架构。"; return 1;; esac; }
snell_latest_tag(){ local major="$1"; curl -fsSL https://api.github.com/repos/surge-networks/snell/releases | jq -r --arg p "v${major}." '[.[].tag_name | select(startswith($p))][0]'; }
download_snell(){ local major="$1" tag arch url tgz; tag="$(snell_latest_tag "$major")"; [[ -n "$tag" && "$tag" != null ]] || { err "获取 Snell v${major} 版本失败。"; return 1; }; arch="$(snell_arch)"; url="https://dl.nssurge.com/snell/snell-server-${tag#v}-linux-${arch}.zip"; tgz="${TMP_DIR}/snell.zip"; wget -O "$tgz" "$url" || return 1; unzip -o "$tgz" -d "${TMP_DIR}/snell" >/dev/null; install -m 755 "${TMP_DIR}/snell/snell-server" "$SNELL_BIN"; printf '%s' "$tag"; }
write_snell_service(){ cat > "$SNELL_SERVICE" <<EOS
[Unit]
Description=Snell Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${SNELL_BIN} -c ${SNELL_CONFIG}
Restart=on-failure
RestartSec=10s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOS
}
install_snell(){ need_root; install_deps; local major="$1" port psk tag; mkdir -p "$SNELL_DIR"; port="$(ask_port "请输入 Snell v${major} 端口")"; read -r -p "请输入 PSK（回车自动生成）: " psk || true; psk="${psk:-$(random_password)}"; tag="$(download_snell "$major")"; cat > "$SNELL_CONFIG" <<EOC
[snell-server]
listen = ::0:${port}
psk = ${psk}
iv = 2020-02-02 20:20:20
EOC
printf 'v%s\n%s\n' "$major" "$tag" > "$SNELL_META"; write_snell_service; systemctl daemon-reload; systemctl enable --now snell.service; allow_tcp_port "$port"; show_snell; }
show_snell(){ if [[ -f "$SNELL_CONFIG" ]]; then local port psk ver server; port="$(awk -F: '/listen/{print $NF}' "$SNELL_CONFIG")"; psk="$(awk -F'= *' '/psk/{print $2}' "$SNELL_CONFIG")"; ver="$(head -n1 "$SNELL_META" 2>/dev/null || printf 'v6')"; server="$(get_public_addr)"; msg "Snell ${ver}\n服务器: ${server}\n端口: ${port}\nPSK: ${psk}\nSurge: snell = snell, ${server}, ${port}, psk=${psk}, version=${ver#v}, tfo=true"; else warn "Snell 未安装。"; fi; }
change_snell_port(){ need_root; [[ -f "$SNELL_CONFIG" ]] || { err "Snell 未安装。"; return 1; }; local p; p="$(ask_port "请输入新 Snell 端口")"; sed -i -E "s#^listen = .*#listen = ::0:${p}#" "$SNELL_CONFIG"; systemctl restart snell.service; allow_tcp_port "$p"; show_snell; }
change_snell_psk(){ need_root; [[ -f "$SNELL_CONFIG" ]] || return 1; local p; read -r -p "请输入新 PSK（回车自动生成）: " p || true; p="${p:-$(random_password)}"; sed -i -E "s#^psk = .*#psk = ${p}#" "$SNELL_CONFIG"; systemctl restart snell.service; show_snell; }
uninstall_snell(){ need_root; systemctl stop snell.service 2>/dev/null || true; systemctl disable snell.service 2>/dev/null || true; rm -f "$SNELL_SERVICE" "$SNELL_BIN"; rm -rf "$SNELL_DIR"; systemctl daemon-reload; ok "Snell 已卸载。"; }

shadow_latest(){ curl -fsSL https://api.github.com/repos/ihciah/shadow-tls/releases/latest | jq -r '.tag_name'; }
install_shadowtls(){ need_root; install_deps; local port pass server; mkdir -p "$SHADOWTLS_DIR"; port="$(ask_port "请输入 ShadowTLS 端口")"; read -r -p "请输入 ShadowTLS 密码（回车自动生成）: " pass || true; pass="${pass:-$(random_password)}"; read -r -p "请输入握手域名（回车 gateway.icloud.com）: " server || true; server="${server:-gateway.icloud.com}"; if has cargo; then cargo install shadow-tls --root /usr/local || true; fi; if ! has shadow-tls; then warn "请确认 shadow-tls 二进制已安装，本脚本将继续写入服务文件。"; fi; cat > "$SHADOWTLS_CONFIG" <<EOC
PORT=${port}
PASSWORD=${pass}
SERVER=${server}
EOC
cat > "$SHADOWTLS_SERVICE" <<EOS
[Unit]
Description=ShadowTLS Server
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=${SHADOWTLS_CONFIG}
ExecStart=${SHADOWTLS_BIN} --v3 server --listen 0.0.0.0:\${PORT} --server \${SERVER}:443 --password \${PASSWORD}
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload; systemctl enable --now shadowtls.service; allow_tcp_port "$port"; show_shadowtls; }
show_shadowtls(){ if [[ -f "$SHADOWTLS_CONFIG" ]]; then cat "$SHADOWTLS_CONFIG"; else warn "ShadowTLS 未安装。"; fi; }
change_shadow_value(){ need_root; local key="$1" prompt="$2" val; [[ -f "$SHADOWTLS_CONFIG" ]] || return 1; read -r -p "$prompt" val || true; [[ -n "$val" ]] || val="$(random_password)"; sed -i -E "s#^${key}=.*#${key}=${val}#" "$SHADOWTLS_CONFIG"; systemctl restart shadowtls.service; show_shadowtls; }
uninstall_shadowtls(){ need_root; systemctl stop shadowtls.service 2>/dev/null || true; systemctl disable shadowtls.service 2>/dev/null || true; rm -f "$SHADOWTLS_SERVICE"; rm -rf "$SHADOWTLS_DIR"; systemctl daemon-reload; ok "ShadowTLS 已卸载。"; }

traffic_menu(){ while true; do msg "${BLUE}流量管理\n1. 查看连接\n2. 查看监听端口\n0. 返回${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) ss -tunap || true; pause;; 2) ss -ltnp || true; pause;; 0) return;; *) warn "无效选择。";; esac; done; }
show_all(){ msg "${BLUE}==== Snell ====${NC}"; show_snell || true; msg "${BLUE}==== ShadowTLS ====${NC}"; show_shadowtls || true; msg "${BLUE}==== AnyTLS ====${NC}"; show_anytls || true; }
show_project_info(){ msg "${BLUE}Snell Toolkit 由 HotKids/Rules 独立维护。${NC}"; msg "本项目不再自动同步外部脚本仓库；如需更新，请拉取 HotKids/Rules 的 master 分支或直接更新本目录源码。"; }

snell_menu(){ while true; do msg "${BLUE}================================================\n Snell 管理菜单\n================================================\n1. 安装/重装 Snell v6\n2. 安装/重装 Snell v5\n3. 切换 Snell 版本\n4. 更新当前 Snell\n5. 查看 Snell 配置\n6. 修改 Snell 端口\n7. 修改 Snell 密码/PSK\n8. 启动 Snell\n9. 停止 Snell\n10. 重启 Snell\n11. 查看 Snell 状态\n12. 查看 Snell 日志\n13. 卸载 Snell\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) install_snell 6;; 2) install_snell 5;; 3) read -r -p "输入目标版本 5 或 6（回车 6）: " v || true; v="${v:-6}"; [[ "$v" == 5 || "$v" == 6 ]] && install_snell "$v" || warn "仅支持 5/6。";; 4) v="$(head -n1 "$SNELL_META" 2>/dev/null | tr -dc '0-9' || printf 6)"; install_snell "${v:-6}";; 5) show_snell; pause;; 6) change_snell_port;; 7) change_snell_psk;; 8) systemctl start snell.service;; 9) systemctl stop snell.service;; 10) systemctl restart snell.service;; 11) systemctl status snell.service --no-pager;; 12) journalctl -u snell.service -n 100 --no-pager;; 13) uninstall_snell;; 0) return;; *) warn "无效选择。";; esac; done; }
shadowtls_menu(){ while true; do msg "${BLUE}================================================\n ShadowTLS 管理菜单\n================================================\n1. 安装/重装 ShadowTLS\n2. 更新 ShadowTLS\n3. 查看 ShadowTLS 配置\n4. 修改 ShadowTLS 端口\n5. 修改 ShadowTLS 密码\n6. 启动 ShadowTLS\n7. 停止 ShadowTLS\n8. 重启 ShadowTLS\n9. 查看 ShadowTLS 状态\n10. 查看 ShadowTLS 日志\n11. 卸载 ShadowTLS\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1|2) install_shadowtls;; 3) show_shadowtls; pause;; 4) change_shadow_value PORT "请输入新端口: ";; 5) change_shadow_value PASSWORD "请输入新密码（回车自动生成）: ";; 6) systemctl start shadowtls.service;; 7) systemctl stop shadowtls.service;; 8) systemctl restart shadowtls.service;; 9) systemctl status shadowtls.service --no-pager;; 10) journalctl -u shadowtls.service -n 100 --no-pager;; 11) uninstall_shadowtls;; 0) return;; *) warn "无效选择。";; esac; done; }
anytls_menu(){ while true; do msg "${BLUE}================================================\n AnyTLS 管理菜单\n================================================\n1. 安装/重装 AnyTLS\n2. 更新 AnyTLS\n3. 查看 AnyTLS 配置\n4. 修改 AnyTLS 端口\n5. 修改 AnyTLS 密码\n6. 修改 AnyTLS 显示名称\n7. 修改 AnyTLS SNI\n8. 启动 AnyTLS\n9. 停止 AnyTLS\n10. 重启 AnyTLS\n11. 查看 AnyTLS 状态\n12. 查看 AnyTLS 日志\n13. 卸载 AnyTLS\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) install_anytls;; 2) update_anytls;; 3) show_anytls; pause;; 4) change_anytls_port;; 5) change_anytls_password;; 6) change_anytls_name;; 7) change_anytls_sni;; 8) systemctl start "$ANYTLS_SERVICE_NAME";; 9) systemctl stop "$ANYTLS_SERVICE_NAME";; 10) systemctl restart "$ANYTLS_SERVICE_NAME";; 11) systemctl status "$ANYTLS_SERVICE_NAME" --no-pager;; 12) journalctl -u "$ANYTLS_SERVICE_NAME" -n 100 --no-pager;; 13) uninstall_anytls;; 0) return;; *) warn "无效选择。";; esac; done; }
main_menu(){ while true; do msg "${GREEN}================================================\n Snell / ShadowTLS / AnyTLS 管理菜单\n================================================\n1. 安装/管理 Snell\n2. 安装/管理 ShadowTLS\n3. 安装/管理 AnyTLS\n4. 流量管理\n5. 查看所有节点配置\n6. 查看项目说明\n0. 退出\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) snell_menu;; 2) shadowtls_menu;; 3) anytls_menu;; 4) traffic_menu;; 5) show_all; pause;; 6) show_project_info; pause;; 0) exit 0;; *) warn "无效选择。";; esac; done; }
main_menu
