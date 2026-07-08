#!/usr/bin/env bash
set -euo pipefail

# Compact Panel provisioner for Snell and SS2022.
# SS2022 follows jinqians/ss-2022.sh: shadowsocks-rust, ss-rust.service,
# /etc/ss-rust/config.json, tcp_and_udp, fast_open, and 2022 key lengths.

SNBIN=/usr/local/bin/snell-server
SNDIR=/etc/snell
SNCONF=$SNDIR/snell-server.conf
SNMETA=$SNDIR/.install_meta
SNSVC=snell-server
SNUNIT=/etc/systemd/system/$SNSVC.service
SSBIN=/usr/local/bin/ss-rust
SSDIR=/etc/ss-rust
SSCONF=$SSDIR/config.json
SSMETA=$SSDIR/.install_meta
SSVER=$SSDIR/ver.txt
SSSVC=ss-rust
SSUNIT=/etc/systemd/system/$SSSVC.service
SURGE=https://dl.nssurge.com/snell
OPEN_API=https://api.github.com/repos/missuo/opensnell/releases/latest
SSR_API=https://api.github.com/repos/shadowsocks/shadowsocks-rust/releases/latest

ACT=${1:-help}; [ $# -gt 0 ] && shift || true
PROTO= API= ID= TOKEN= API_TOKEN= VER= SNVER= SSVER_IN= METHOD= IP= PORT= NAME=
VARIANT=official; TFO=true; PSK=

die(){ echo "[ERROR] $*" >&2; exit 1; }
log(){ echo "[INFO] $*"; }
ok(){ echo "[OK] $*"; }
root(){ [ "$(id -u)" -eq 0 ] || die "Please run as root."; }
need(){ [ -n "$2" ] || die "Missing required flag: $1"; }
yes(){ case "$(printf %s "$1"|tr A-Z a-z)" in 1|true|yes|on) return 0;; *) return 1;; esac; }
esc(){ local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf %s "$s"; }

usage(){ cat <<EOF
Usage: $0 install|upgrade|uninstall|status|restart [flags]
  --protocol snell|ss2022 --api-url URL --node-id ID --token TOKEN
  --version 5|6|2022 --snell-version VER --method SS2022_METHOD
  --ip HOST --port PORT --name NAME --variant official|opensnell --tfo true|false
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --protocol) PROTO=${2:-}; shift 2;; --api-url) API=${2:-}; shift 2;;
    --node-id) ID=${2:-}; shift 2;; --token) TOKEN=${2:-}; shift 2;;
    --api-token) API_TOKEN=${2:-}; shift 2;; --version) VER=${2:-}; shift 2;;
    --snell-version) SNVER=${2:-}; shift 2;; --ss-version) SSVER_IN=${2:-}; shift 2;;
    --method|--ss-method) METHOD=${2:-}; shift 2;; --ip) IP=${2:-}; shift 2;;
    --port) PORT=${2:-}; shift 2;; --name) NAME=${2:-}; shift 2;;
    --variant) VARIANT=${2:-}; shift 2;; --tfo) TFO=${2:-}; shift 2;;
    -h|--help) usage; exit 0;; *) die "Unknown option: $1";;
  esac
done

norm(){
  [ -n "$PROTO" ] || PROTO=snell
  case "$PROTO" in ss|shadowsocks|shadowsocks-rust) PROTO=ss2022;; snell|ss2022);; *) die "Unsupported protocol: $PROTO";; esac
  if [ "$PROTO" = snell ]; then
    VER=${VER:-6}; [ "$VER" = 5 ] || [ "$VER" = 6 ] || die "Snell version must be 5 or 6"
    [ -n "$SNVER" ] || { [ "$VER" = 6 ] && SNVER=v6.0.0b4 || SNVER=v5.0.1; }
  else
    VER=2022; METHOD=${METHOD:-2022-blake3-aes-128-gcm}
    case "$METHOD" in 2022-blake3-aes-128-gcm|2022-blake3-aes-256-gcm|2022-blake3-chacha20-poly1305|2022-blake3-chacha8-poly1305);; *) die "Unsupported SS2022 method: $METHOD";; esac
  fi
}

deps(){
  for b in curl openssl shuf ss sysctl systemctl tar unzip; do command -v "$b" >/dev/null 2>&1 || miss=1; done
  [ "${miss:-0}" = 0 ] && return
  log "Installing dependencies"
  if command -v apt-get >/dev/null; then apt-get update -qq; apt-get install -y ca-certificates curl unzip openssl iproute2 procps coreutils tar xz-utils
  elif command -v dnf >/dev/null; then dnf install -y ca-certificates curl unzip openssl iproute procps-ng coreutils tar xz
  elif command -v yum >/dev/null; then yum install -y ca-certificates curl unzip openssl iproute procps-ng coreutils tar xz
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm ca-certificates curl unzip openssl iproute2 procps-ng coreutils tar xz
  else die "Install curl unzip openssl iproute2 procps coreutils tar xz first"; fi
}

tag(){ curl -fsSL "$1"|grep '"tag_name":'|head -1|sed -E 's/.*"([^"]+)".*/\1/'; }
pubip(){ for u in https://api.ip.sb/ip https://ipinfo.io/ip https://api.ipify.org; do curl -fsS4 -m 8 "$u" 2>/dev/null|tr -d '[:space:]' && return 0 || true; done; }
freeport(){ for _ in $(seq 1 25); do p=$(shuf -i 20000-59999 -n 1); ss -ltnu|grep -q ":$p[[:space:]]" || { echo "$p"; return; }; done; shuf -i 20000-59999 -n 1; }
backup(){ [ -e "$1" ] && cp -a "$1" "$1.bak.$(date +%Y%m%d-%H%M%S)" || true; }
tfo(){ yes "$TFO" || return 0; grep -q '^net.ipv4.tcp_fastopen' /etc/sysctl.conf 2>/dev/null && sed -i 's/^net.ipv4.tcp_fastopen.*/net.ipv4.tcp_fastopen = 3/' /etc/sysctl.conf || echo 'net.ipv4.tcp_fastopen = 3' >> /etc/sysctl.conf; sysctl -p >/dev/null 2>&1 || true; }
openport(){ local p=$1 r=$2; command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1 && { firewall-cmd --add-port=$p/$r --permanent >/dev/null || true; firewall-cmd --reload >/dev/null || true; return; }; command -v ufw >/dev/null && ufw status 2>/dev/null|grep -q active && { ufw allow "$p/$r" >/dev/null || true; return; }; command -v iptables >/dev/null && { iptables -C INPUT -p "$r" --dport "$p" -j ACCEPT >/dev/null 2>&1 || iptables -I INPUT -p "$r" --dport "$p" -j ACCEPT >/dev/null 2>&1 || true; }; }

sn_arch(){ case "$(uname -m)" in x86_64) echo amd64;; aarch64|arm64) echo aarch64;; i386|i686) echo i386;; armv7l|armv7) echo armv7l;; *) die "Unsupported arch";; esac; }
open_arch(){ case "$(uname -m)" in x86_64) echo amd64;; aarch64|arm64) echo arm64;; i386|i686) echo 386;; armv7l|armv7) echo armv7;; *) die "Unsupported arch";; esac; }
ss_arch(){ case "$(uname -m)" in x86_64) echo x86_64-unknown-linux-gnu;; aarch64|arm64) echo aarch64-unknown-linux-gnu;; armv7l|armv7) echo armv7-unknown-linux-gnueabihf;; armv6l) echo arm-unknown-linux-gnueabi;; i386|i686) echo i686-unknown-linux-musl;; *) die "Unsupported arch";; esac; }

dl_snell(){
  mkdir -p "$SNDIR"; tmp=$(mktemp -d)
  if [ "$VARIANT" = opensnell ]; then
    [ "$VER" = 5 ] || die "OpenSnell only supports V5"; a=$(open_arch); tg=$(tag "$OPEN_API")
    curl -fL --progress-bar -o "$tmp/snell-server" "https://github.com/missuo/opensnell/releases/download/$tg/snell-server-linux-$a"; SNVER=$tg
  else
    a=$(sn_arch); [ "$VER" = 6 ] && [ "$a" = armv7l ] && die "Snell V6 has no armv7l build"
    curl -fL --progress-bar -o "$tmp/s.zip" "$SURGE/snell-server-$SNVER-linux-$a.zip"; unzip -q -o "$tmp/s.zip" -d "$tmp"
  fi
  install -m 0755 "$tmp/snell-server" "$SNBIN"; rm -rf "$tmp"
}

dl_ss(){
  mkdir -p "$SSDIR"; a=$(ss_arch); v=${SSVER_IN#v}
  [ -n "$v" ] || { tg=$(tag "$SSR_API"); v=${tg#v}; }
  f=shadowsocks-v$v.$a.tar.xz; tmp=$(mktemp -d)
  curl -fL --progress-bar -o "$tmp/$f" "https://github.com/shadowsocks/shadowsocks-rust/releases/download/v$v/$f"
  tar -xf "$tmp/$f" -C "$tmp"; [ -f "$tmp/ssserver" ] || die "ssserver missing"
  install -m 0755 "$tmp/ssserver" "$SSBIN"; echo "$v" > "$SSVER"; rm -rf "$tmp"
}

genpsk(){ [ "$PROTO" = ss2022 ] && { [ "$METHOD" = 2022-blake3-aes-128-gcm ] && openssl rand -base64 16 || openssl rand -base64 32; } | tr -d '\n' || openssl rand -base64 48|tr -d '/+='|cut -c1-32; }

write_conf(){
  if [ "$PROTO" = ss2022 ]; then
    mkdir -p "$SSDIR"; cat > "$SSCONF" <<EOF
{"server":"::","server_port":$PORT,"password":"$PSK","method":"$METHOD","fast_open":$(yes "$TFO"&&echo true||echo false),"mode":"tcp_and_udp","user":"nobody","timeout":300}
EOF
    chmod 600 "$SSCONF"
  else
    mkdir -p "$SNDIR"; { echo "[snell-server]"; echo "listen = 0.0.0.0:$PORT"; echo "psk = $PSK"; [ "$VER" = 6 ] && echo "dns-ip-preference = default" || echo "ipv6 = false"; } > "$SNCONF"; chmod 600 "$SNCONF"
  fi
}

write_unit(){
  if [ "$PROTO" = ss2022 ]; then
    cat > "$SSUNIT" <<EOF
[Unit]
Description=Shadowsocks Rust SS2022 Service
After=network-online.target
Wants=network-online.target systemd-networkd-wait-online.service
[Service]
Type=simple
User=root
ExecStart=$SSBIN -c $SSCONF
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF
  else
    cat > "$SNUNIT" <<EOF
[Unit]
Description=Snell Server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=$SNBIN -c $SNCONF
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF
  fi
  systemctl daemon-reload
}

meta(){
  if [ "$PROTO" = ss2022 ]; then
    mkdir -p "$SSDIR"; printf "protocol=ss2022\nversion=2022\nmethod=%s\nport=%s\npsk=%s\nnode_id=%s\napi_url=%s\nreport_ip=%s\ntfo=%s\n" "$METHOD" "$PORT" "$PSK" "$ID" "$API" "$IP" "$TFO" > "$SSMETA"; chmod 600 "$SSMETA"
  else
    mkdir -p "$SNDIR"; printf "protocol=snell\nvariant=%s\nversion=%s\nsnell_version=%s\nport=%s\npsk=%s\nnode_id=%s\napi_url=%s\nreport_ip=%s\ntfo=%s\n" "$VARIANT" "$VER" "$SNVER" "$PORT" "$PSK" "$ID" "$API" "$IP" "$TFO" > "$SNMETA"; chmod 600 "$SNMETA"
  fi
}
metaget(){ [ -f "$1" ] && grep "^$2=" "$1"|head -1|cut -d= -f2- || true; }
detect(){ [ -f "$SSMETA" ] || [ -f "$SSUNIT" ] && { echo ss2022; return; }; [ -f "$SNMETA" ] || [ -f "$SNUNIT" ] && { echo snell; return; }; echo snell; }

verify_install(){ [ -n "$API" ] && [ -n "$ID" ] && [ -n "$TOKEN" ] || return 0; curl -fsS "$API/api/nodes/$ID/verify-token?token=$TOKEN" >/dev/null; }
report_failed(){
  rc=$?; [ "$rc" -eq 0 ] && return 0
  msg=$(esc "install failed at line ${BASH_LINENO[0]} with exit code $rc")
  [ -n "$API" ] && [ -n "$ID" ] && [ -n "$TOKEN" ] && curl -fsS -X POST "$API/api/nodes/$ID/install-failed?token=$TOKEN" -H "Content-Type: application/json" -d "{\"error\":\"$msg\"}" >/dev/null 2>&1 || true
  exit "$rc"
}
register(){
  [ -n "$API" ] && [ -n "$ID" ] && [ -n "$TOKEN" ] || return 0
  mj= ij=; [ "$PROTO" = ss2022 ] && mj=",\"method\":\"$(esc "$METHOD")\""; [ -n "$IP" ] && ij=",\"ip\":\"$(esc "$IP")\""
  data="{\"protocol\":\"$PROTO\",\"port\":$PORT,\"psk\":\"$(esc "$PSK")\",\"version\":\"$VER\"$mj$ij}"
  curl -fsS -X POST "$API/api/nodes/$ID/register?token=$TOKEN" -H "Content-Type: application/json" -d "$data" >/dev/null
}
del_panel(){ [ -n "$API" ] && [ -n "$ID" ] || return 0; t=${API_TOKEN:-$TOKEN}; [ -n "$t" ] && curl -fsS -X DELETE "$API/api/nodes/$ID?token=$t" >/dev/null || true; }

install_node(){
  trap report_failed ERR
  root; norm; need --api-url "$API"; need --node-id "$ID"; need --token "$TOKEN"; verify_install; deps
  PORT=${PORT:-$(freeport)}; IP=${IP:-$(pubip || true)}; PSK=$(genpsk)
  if [ "$PROTO" = ss2022 ]; then log "Installing SS2022 $METHOD"; backup "$SSBIN"; backup "$SSCONF"; backup "$SSUNIT"; dl_ss; write_conf; tfo; write_unit; systemctl enable "$SSSVC" >/dev/null 2>&1 || true; systemctl restart "$SSSVC"; systemctl is-active --quiet "$SSSVC"; openport "$PORT" tcp; openport "$PORT" udp
  else log "Installing Snell V$VER $SNVER"; backup "$SNBIN"; backup "$SNCONF"; backup "$SNUNIT"; dl_snell; write_conf; tfo; write_unit; systemctl enable "$SNSVC" >/dev/null 2>&1 || true; systemctl restart "$SNSVC"; systemctl is-active --quiet "$SNSVC"; openport "$PORT" tcp; fi
  meta; log "Registering installed node with panel"; register; trap - ERR; ok "Installed $PROTO"; printf "Protocol: %s\nPort: %s\nPassword/PSK: %s\n" "$PROTO" "$PORT" "$PSK"; [ -n "$IP" ] && echo "IP: $IP"
}

uninstall_node(){
  root; [ -n "$PROTO" ] || PROTO=$(detect); norm
  if [ "$PROTO" = ss2022 ]; then systemctl stop "$SSSVC" 2>/dev/null || true; systemctl disable "$SSSVC" 2>/dev/null || true; rm -f "$SSUNIT" "$SSBIN"; rm -rf "$SSDIR"
  else systemctl stop "$SNSVC" 2>/dev/null || true; systemctl disable "$SNSVC" 2>/dev/null || true; rm -f "$SNUNIT" "$SNBIN"; rm -rf "$SNDIR"; fi
  systemctl daemon-reload; del_panel; ok "Removed $PROTO"
}

upgrade_node(){
  root; PROTO=snell; VER=6; norm; deps; [ -f "$SNCONF" ] || die "No Snell config at $SNCONF"
  PORT=$(grep -E '^[[:space:]]*listen' "$SNCONF"|head -1|sed -E 's/.*:([0-9]+).*/\1/')
  PSK=$(grep -E '^[[:space:]]*psk' "$SNCONF"|head -1|cut -d= -f2-|tr -d ' ')
  [ -n "$PORT" ] && [ -n "$PSK" ] || die "Could not read existing Snell port/psk"
  IP=${IP:-$(metaget "$SNMETA" report_ip)}; ID=${ID:-$(metaget "$SNMETA" node_id)}; API=${API:-$(metaget "$SNMETA" api_url)}
  backup "$SNBIN"; backup "$SNCONF"; backup "$SNUNIT"; dl_snell; write_conf; write_unit; systemctl restart "$SNSVC"; openport "$PORT" tcp; meta; [ -n "$TOKEN" ] && register || true; ok "Upgraded Snell to V6"
}

status_node(){ [ -n "$PROTO" ] || { systemctl status "$SNSVC" --no-pager || true; systemctl status "$SSSVC" --no-pager || true; exit 0; }; norm; [ "$PROTO" = ss2022 ] && systemctl status "$SSSVC" --no-pager || systemctl status "$SNSVC" --no-pager; }
restart_node(){ root; [ -n "$PROTO" ] || PROTO=$(detect); norm; [ "$PROTO" = ss2022 ] && systemctl restart "$SSSVC" || systemctl restart "$SNSVC"; ok "Restarted $PROTO"; }

case "$ACT" in
  install|provision|setup) install_node;;
  uninstall) uninstall_node;;
  upgrade) upgrade_node;;
  status) status_node;;
  restart) restart_node;;
  help|-h|--help|"") usage;;
  *) die "Unknown command: $ACT";;
esac
