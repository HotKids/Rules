#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${ROOT_DIR}/snell"
MAIN_SCRIPT="${WORK_DIR}/snell-anytls.sh"
SYNC_SCRIPT="${WORK_DIR}/sync-upstream.sh"
UPSTREAM_DIR="${WORK_DIR}/upstream"
TMP_DIR="$(mktemp -d)"
UPSTREAM_REPO="https://github.com/jinqians/snell.sh.git"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
trap 'rm -rf "${TMP_DIR}"' EXIT

log(){ printf '[sync] %s\n' "$1"; }
fail(){ printf '[sync][error] %s\n' "$1" >&2; exit 1; }

copy_if_exists(){
  local src="$1" dst="$2"
  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    log "saved ${dst#${ROOT_DIR}/}"
  fi
}

check_forbidden_keywords(){
  local patterns=(
    'VLESS' 'vless' 'REALITY' 'reality' 'sing-box' 'singbox' 'Xray' 'xray'
    'private_key' 'public_key' 'short_id' 'Snell v4' 'snell v4'
    'snell-server-v4' 'SNELL_V4' 'snell_v4' 'install_snell_v4' 'download_snell_v4'
  )
  local pattern joined
  joined="$(printf '%s\n' "${patterns[@]}" | sed 's/[.[\*^$()+?{}|]/\\&/g' | paste -sd '|' -)"
  if grep -nE "$joined" "$MAIN_SCRIPT"; then
    fail "主脚本出现禁止关键词，请确认没有把上游禁用功能同步进主脚本。"
  fi
}

check_anytls_output(){
  grep -q 'anytls://' "$MAIN_SCRIPT" || fail "主脚本缺少 AnyTLS URI 输出。"
  grep -q 'Surge:' "$MAIN_SCRIPT" || fail "主脚本缺少 Surge 输出。"
  grep -q 'mihomo:' "$MAIN_SCRIPT" || fail "主脚本缺少 mihomo 输出。"
}

log "clone upstream ${UPSTREAM_REPO} (${UPSTREAM_BRANCH})"
git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "${TMP_DIR}/snell.sh"
mkdir -p "$UPSTREAM_DIR"
rm -rf "${UPSTREAM_DIR:?}/"*

copy_if_exists "${TMP_DIR}/snell.sh/snell.sh" "${UPSTREAM_DIR}/snell.sh"
copy_if_exists "${TMP_DIR}/snell.sh/README.md" "${UPSTREAM_DIR}/README.md"
copy_if_exists "${TMP_DIR}/snell.sh/LICENSE" "${UPSTREAM_DIR}/LICENSE"
find "${TMP_DIR}/snell.sh" -maxdepth 2 -type f \( -name '*.sh' -o -name '*.service' -o -name '*.conf' \) | while IFS= read -r file; do
  rel="${file#${TMP_DIR}/snell.sh/}"
  copy_if_exists "$file" "${UPSTREAM_DIR}/${rel}"
done

git -C "${TMP_DIR}/snell.sh" rev-parse HEAD > "${UPSTREAM_DIR}/UPSTREAM_COMMIT"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "${UPSTREAM_DIR}/SYNCED_AT"
cat > "${UPSTREAM_DIR}/README.md" <<'EON'
# Upstream snapshot

This directory stores raw files fetched from https://github.com/jinqians/snell.sh for review and comparison only.

Do not source these files directly from the local management script. Local AnyTLS logic must remain in snell/snell-anytls.sh and upstream snapshots must not be copied wholesale into it.
EON

log "run syntax checks"
bash -n "$MAIN_SCRIPT"
bash -n "$SYNC_SCRIPT"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$MAIN_SCRIPT"
  shellcheck "$SYNC_SCRIPT"
else
  log "shellcheck not installed, skipped"
fi

check_forbidden_keywords
check_anytls_output
log "upstream snapshot updated; review snell/upstream/ before manually porting allowed changes"
