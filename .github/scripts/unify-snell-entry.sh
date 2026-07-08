#!/usr/bin/env bash
set -euo pipefail

git apply <<'PATCH'
diff --git a/snell/README.md b/snell/README.md
index 899a0c06..6d979da9 100644
--- a/snell/README.md
+++ b/snell/README.md
@@ -1,13 +1,13 @@
 # Snell Toolkit
 
-`snell/` 是 `HotKids/Rules` 里独立维护的 Snell 工具项目，当前整合为两部分：
+`snell/` 是 `HotKids/Rules` 里独立维护的 Snell Toolkit。现在只保留一个入口脚本：
 
-- `snell-anytls.sh`：VPS 上使用的一键管理脚本，管理 Snell、ShadowTLS、AnyTLS 和基础流量查看。
-- `panel/`：Cloudflare Workers + D1 + React 面板源码，管理 Snell 节点并生成订阅。
+- `snell-anytls.sh`：统一管理 Snell、ShadowTLS、AnyTLS、基础流量查看和 Snell Panel。
+- `panel/`：面板源码目录，由 `snell-anytls.sh` 的 Snell Panel 菜单调用和管理。
 
 本目录按当前代码独立维护，不再保留外部快照，不再自动同步外部脚本仓库。
 
-## 一键脚本
+## 统一入口脚本
 
 本地运行：
 
@@ -27,6 +27,7 @@ bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/s
 - Snell v5 / v6 安装、切换、更新、查看、卸载
 - ShadowTLS 安装、更新、查看、卸载
 - AnyTLS 安装、更新、查看、卸载
+- Snell Panel 依赖安装、本地变量写入、本地迁移、开发服务、构建和部署
 - 查看当前节点配置
 - 查看连接和监听端口
 
@@ -34,7 +35,7 @@ bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/s
 
 ## 面板
 
-面板源码直接放在 `snell/panel/`，作为普通源码目录维护。
+面板源码直接放在 `snell/panel/`，作为普通源码目录维护。日常使用直接运行 `snell/snell-anytls.sh`，然后进入 `管理 Snell Panel`。
 
 面板支持：
 
@@ -43,15 +44,13 @@ bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/s
 - Surge / Shadowrocket / Mihomo 订阅
 - 节点启用、禁用、Relay 和升级
 
-部署入口：
+如果只想管理面板，不需要 root 权限：
 
 ```bash
-cd snell/panel
-bun install
-bunx wrangler login
+bash snell/snell-anytls.sh
 ```
 
-随后按 `snell/panel/README.md` 创建 D1、设置 `ACCESS_TOKEN` / `API_TOKEN` 并部署 Worker。
+面板部署前仍需要按 `snell/panel/README.md` 创建 D1，并设置 `ACCESS_TOKEN` / `API_TOKEN`。
 
 ## AnyTLS 输出示例
 
diff --git a/snell/snell-anytls.sh b/snell/snell-anytls.sh
index 2fcc4e15..5a566951 100755
--- a/snell/snell-anytls.sh
+++ b/snell/snell-anytls.sh
@@ -277,8 +277,39 @@ traffic_menu(){ while true; do msg "${BLUE}流量管理\n1. 查看连接\n2. 查
 show_all(){ msg "${BLUE}==== Snell ====${NC}"; show_snell || true; msg "${BLUE}==== ShadowTLS ====${NC}"; show_shadowtls || true; msg "${BLUE}==== AnyTLS ====${NC}"; show_anytls || true; }
 show_project_info(){ msg "${BLUE}Snell Toolkit 由 HotKids/Rules 独立维护。${NC}"; msg "本项目不再自动同步外部脚本仓库；如需更新，请拉取 HotKids/Rules 的 master 分支或直接更新本目录源码。"; }
 
+panel_dir(){
+  local script_dir candidates d
+  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd || true)"
+  candidates=("${PANEL_DIR:-}" "${script_dir}/panel" "$(pwd)/snell/panel" "$(pwd)/panel")
+  for d in "${candidates[@]}"; do
+    [[ -n "$d" ]] || continue
+    if [[ -f "${d}/package.json" && -f "${d}/apps/server/wrangler.jsonc" ]]; then
+      printf '%s' "$d"; return 0
+    fi
+  done
+  return 1
+}
+panel_path_or_warn(){ local d; d="$(panel_dir)" || { warn "未找到面板源码目录。请在 Rules 仓库中运行，或设置 PANEL_DIR=/path/to/snell/panel。"; return 1; }; printf '%s' "$d"; }
+panel_require_bun(){ has bun || { warn "未找到 bun。请先安装 Bun：https://bun.sh"; return 1; }; }
+panel_status(){ local d; d="$(panel_path_or_warn)" || return 0; msg "${BLUE}Snell Panel${NC}\n目录: ${d}\n配置: ${d}/apps/server/wrangler.jsonc\n本地变量: ${d}/apps/server/.dev.vars"; if has bun; then msg "Bun: $(bun --version)"; else warn "Bun: 未安装"; fi; if has wrangler; then msg "Wrangler: $(wrangler --version 2>/dev/null | head -n1)"; elif [[ -x "${d}/node_modules/.bin/wrangler" ]]; then msg "Wrangler: $("${d}/node_modules/.bin/wrangler" --version 2>/dev/null | head -n1)"; else warn "Wrangler: 未安装（安装面板依赖后可用）"; fi; }
+panel_install_deps(){ local d; d="$(panel_path_or_warn)" || return 0; panel_require_bun || return 0; (cd "$d" && bun install); }
+panel_write_dev_vars(){ local d access api; d="$(panel_path_or_warn)" || return 0; read -r -p "ACCESS_TOKEN（面板登录令牌，回车 dev-access-token）: " access || true; access="${access:-dev-access-token}"; read -r -p "API_TOKEN（后端 API 令牌，回车 dev-api-token）: " api || true; api="${api:-dev-api-token}"; cat > "${d}/apps/server/.dev.vars" <<EOC
+ACCESS_TOKEN=${access}
+API_TOKEN=${api}
+ENVIRONMENT=development
+EOC
+  ok "已写入 ${d}/apps/server/.dev.vars"
+}
+panel_local_migrate(){ local d; d="$(panel_path_or_warn)" || return 0; panel_require_bun || return 0; (cd "$d" && bun run db:migrate:local); }
+panel_dev_worker(){ local d; d="$(panel_path_or_warn)" || return 0; panel_require_bun || return 0; msg "启动 Worker 本地开发服务，退出请按 Ctrl-C。"; (cd "$d" && bun run dev); }
+panel_dev_web(){ local d; d="$(panel_path_or_warn)" || return 0; panel_require_bun || return 0; msg "启动 Web 本地开发服务，退出请按 Ctrl-C。"; (cd "$d" && bun run dev:web); }
+panel_build(){ local d; d="$(panel_path_or_warn)" || return 0; panel_require_bun || return 0; (cd "$d" && bun run build); }
+panel_deploy(){ local d; d="$(panel_path_or_warn)" || return 0; panel_require_bun || return 0; warn "部署前请确认 apps/server/wrangler.jsonc 已填入 D1 database_id，并已设置 ACCESS_TOKEN / API_TOKEN。"; (cd "$d" && bun run deploy); }
+panel_show_readme(){ local d; d="$(panel_path_or_warn)" || return 0; sed -n '1,180p' "${d}/README.md"; }
+
 snell_menu(){ while true; do msg "${BLUE}================================================\n Snell 管理菜单\n================================================\n1. 安装/重装 Snell v6\n2. 安装/重装 Snell v5\n3. 切换 Snell 版本\n4. 更新当前 Snell\n5. 查看 Snell 配置\n6. 修改 Snell 端口\n7. 修改 Snell 密码/PSK\n8. 启动 Snell\n9. 停止 Snell\n10. 重启 Snell\n11. 查看 Snell 状态\n12. 查看 Snell 日志\n13. 卸载 Snell\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) install_snell 6;; 2) install_snell 5;; 3) read -r -p "输入目标版本 5 或 6（回车 6）: " v || true; v="${v:-6}"; [[ "$v" == 5 || "$v" == 6 ]] && install_snell "$v" || warn "仅支持 5/6。";; 4) v="$(head -n1 "$SNELL_META" 2>/dev/null | tr -dc '0-9' || printf 6)"; install_snell "${v:-6}";; 5) show_snell; pause;; 6) change_snell_port;; 7) change_snell_psk;; 8) systemctl start snell.service;; 9) systemctl stop snell.service;; 10) systemctl restart snell.service;; 11) systemctl status snell.service --no-pager;; 12) journalctl -u snell.service -n 100 --no-pager;; 13) uninstall_snell;; 0) return;; *) warn "无效选择。";; esac; done; }
 shadowtls_menu(){ while true; do msg "${BLUE}================================================\n ShadowTLS 管理菜单\n================================================\n1. 安装/重装 ShadowTLS\n2. 更新 ShadowTLS\n3. 查看 ShadowTLS 配置\n4. 修改 ShadowTLS 端口\n5. 修改 ShadowTLS 密码\n6. 启动 ShadowTLS\n7. 停止 ShadowTLS\n8. 重启 ShadowTLS\n9. 查看 ShadowTLS 状态\n10. 查看 ShadowTLS 日志\n11. 卸载 ShadowTLS\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1|2) install_shadowtls;; 3) show_shadowtls; pause;; 4) change_shadow_value PORT "请输入新端口: ";; 5) change_shadow_value PASSWORD "请输入新密码（回车自动生成）: ";; 6) systemctl start shadowtls.service;; 7) systemctl stop shadowtls.service;; 8) systemctl restart shadowtls.service;; 9) systemctl status shadowtls.service --no-pager;; 10) journalctl -u shadowtls.service -n 100 --no-pager;; 11) uninstall_shadowtls;; 0) return;; *) warn "无效选择。";; esac; done; }
 anytls_menu(){ while true; do msg "${BLUE}================================================\n AnyTLS 管理菜单\n================================================\n1. 安装/重装 AnyTLS\n2. 更新 AnyTLS\n3. 查看 AnyTLS 配置\n4. 修改 AnyTLS 端口\n5. 修改 AnyTLS 密码\n6. 修改 AnyTLS 显示名称\n7. 修改 AnyTLS SNI\n8. 启动 AnyTLS\n9. 停止 AnyTLS\n10. 重启 AnyTLS\n11. 查看 AnyTLS 状态\n12. 查看 AnyTLS 日志\n13. 卸载 AnyTLS\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) install_anytls;; 2) update_anytls;; 3) show_anytls; pause;; 4) change_anytls_port;; 5) change_anytls_password;; 6) change_anytls_name;; 7) change_anytls_sni;; 8) systemctl start "$ANYTLS_SERVICE_NAME";; 9) systemctl stop "$ANYTLS_SERVICE_NAME";; 10) systemctl restart "$ANYTLS_SERVICE_NAME";; 11) systemctl status "$ANYTLS_SERVICE_NAME" --no-pager;; 12) journalctl -u "$ANYTLS_SERVICE_NAME" -n 100 --no-pager;; 13) uninstall_anytls;; 0) return;; *) warn "无效选择。";; esac; done; }
-main_menu(){ while true; do msg "${GREEN}================================================\n Snell / ShadowTLS / AnyTLS 管理菜单\n================================================\n1. 安装/管理 Snell\n2. 安装/管理 ShadowTLS\n3. 安装/管理 AnyTLS\n4. 流量管理\n5. 查看所有节点配置\n6. 查看项目说明\n0. 退出\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) snell_menu;; 2) shadowtls_menu;; 3) anytls_menu;; 4) traffic_menu;; 5) show_all; pause;; 6) show_project_info; pause;; 0) exit 0;; *) warn "无效选择。";; esac; done; }
+panel_menu(){ while true; do msg "${BLUE}================================================\n Snell Panel 管理菜单\n================================================\n1. 查看面板状态\n2. 安装/更新面板依赖\n3. 写入本地开发变量\n4. 执行本地 D1 迁移\n5. 启动 Worker 本地开发\n6. 启动 Web 本地开发\n7. 构建面板\n8. 部署面板到 Cloudflare Workers\n9. 查看面板说明\n0. 返回主菜单\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) panel_status; pause;; 2) panel_install_deps; pause;; 3) panel_write_dev_vars; pause;; 4) panel_local_migrate; pause;; 5) panel_dev_worker;; 6) panel_dev_web;; 7) panel_build; pause;; 8) panel_deploy; pause;; 9) panel_show_readme; pause;; 0) return;; *) warn "无效选择。";; esac; done; }
+main_menu(){ while true; do msg "${GREEN}================================================\n Snell Toolkit 管理菜单\n================================================\n1. 安装/管理 Snell\n2. 安装/管理 ShadowTLS\n3. 安装/管理 AnyTLS\n4. 管理 Snell Panel\n5. 流量管理\n6. 查看所有节点配置\n7. 查看项目说明\n0. 退出\n================================================${NC}"; read -r -p "请选择: " c || true; case "$c" in 1) snell_menu;; 2) shadowtls_menu;; 3) anytls_menu;; 4) panel_menu;; 5) traffic_menu;; 6) show_all; pause;; 7) show_project_info; pause;; 0) exit 0;; *) warn "无效选择。";; esac; done; }
 main_menu
PATCH

rm -f .github/scripts/unify-snell-entry.sh .github/workflows/unify-snell-entry.yml .github/run-unify-snell-entry

bash -n snell/snell-anytls.sh
printf '0\n' | bash snell/snell-anytls.sh >/tmp/snell-menu.txt
printf '4\n1\n\n0\n0\n' | bash snell/snell-anytls.sh >/tmp/snell-panel-menu.txt

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add snell/snell-anytls.sh snell/README.md .github/scripts/unify-snell-entry.sh .github/workflows/unify-snell-entry.yml .github/run-unify-snell-entry
if git diff --cached --quiet; then
  echo "No changes to commit"
  exit 0
fi
git commit -m "feat: add unified snell toolkit entry"
git push
