#!/usr/bin/env bash
set -euo pipefail

rm -f .github/workflows/sync-snell.yml
rm -f snell/PANEL.md snell/UPSTREAM_SYNC.md snell/sync-upstream.sh snell/panel/UPSTREAM.md
rm -rf snell/upstream

cat > snell/README.md <<'EOF'
# Snell Toolkit

`snell/` 是 `HotKids/Rules` 里独立维护的 Snell 工具项目，当前整合为两部分：

- `snell-anytls.sh`：VPS 上使用的一键管理脚本，管理 Snell、ShadowTLS、AnyTLS 和基础流量查看。
- `panel/`：Cloudflare Workers + D1 + React 面板源码，管理 Snell 节点并生成订阅。

本目录按当前代码独立维护，不再保留外部快照，不再自动同步外部脚本仓库。

## 一键脚本

本地运行：

```bash
chmod +x snell/snell-anytls.sh
sudo bash snell/snell-anytls.sh
```

远程运行：

```bash
bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/snell-anytls.sh)
```

脚本功能：

- Snell v5 / v6 安装、切换、更新、查看、卸载
- ShadowTLS 安装、更新、查看、卸载
- AnyTLS 安装、更新、查看、卸载
- 查看当前节点配置
- 查看连接和监听端口

本脚本不使用 VLESS / REALITY / sing-box / Xray，并已移除 Snell v4，仅保留 Snell v5 / v6。

## 面板

面板源码直接放在 `snell/panel/`，作为普通源码目录维护。

面板支持：

- Snell v5 / v6 节点管理
- 一次性安装命令
- Surge / Shadowrocket / Mihomo 订阅
- 节点启用、禁用、Relay 和升级

部署入口：

```bash
cd snell/panel
bun install
bunx wrangler login
```

随后按 `snell/panel/README.md` 创建 D1、设置 `ACCESS_TOKEN` / `API_TOKEN` 并部署 Worker。

## AnyTLS 输出示例

AnyTLS URI：

```text
anytls://example-password@1.2.3.4:8443
```

Surge 单行格式：

```text
HK-AnyTLS = anytls, 1.2.3.4, 8443, password="example-password", sni="www.apple.com", skip-cert-verify=true, tfo=true
```

mihomo 单行 YAML 格式：

```yaml
- {name: "HK-AnyTLS", type: anytls, server: 1.2.3.4, port: 8443, password: "example-password", client-fingerprint: chrome, udp: true, sni: "www.apple.com", skip-cert-verify: true}
```

## 维护方式

- 直接修改 `snell/snell-anytls.sh` 和 `snell/panel/` 中的源码。
- 如需吸收外部实现，先人工阅读并改写为本项目代码，再提交到本仓库。
- 不再保留外部脚本快照目录。
- 不再提供 Snell 自动同步 workflow。

## 注意事项

- 需要手动确认 VPS 安全组放行 Snell、ShadowTLS 或 AnyTLS 对应 TCP 端口。
- 本脚本不关闭防火墙。
- 本脚本不清空防火墙规则。
- 本脚本会尽量通过 `firewalld` 或 `ufw` 添加单个 TCP 端口放行规则，但不会禁用防火墙。
- 生产环境请先在测试 VPS 上验证客户端兼容性。
EOF

python3 - <<'PY'
from pathlib import Path

script = Path('snell/snell-anytls.sh')
text = script.read_text()
text = text.replace('update_script(){ if [[ -f "snell/sync-upstream.sh" ]]; then bash snell/sync-upstream.sh; else warn "未找到同步脚本。"; fi; }', 'show_project_info(){ msg "${BLUE}Snell Toolkit 由 HotKids/Rules 独立维护。${NC}"; msg "本项目不再自动同步外部脚本仓库；如需更新，请拉取 HotKids/Rules 的 master 分支或直接更新本目录源码。"; }')
text = text.replace('6. 更新脚本\\n0. 退出', '6. 查看项目说明\\n0. 退出')
text = text.replace('6) update_script; pause;;', '6) show_project_info; pause;;')
script.write_text(text)

panel_readme = Path('snell/panel/README.md')
text = panel_readme.read_text()
text = text.replace('## Repository integration', '## Project integration')
text = text.replace('This panel is vendored into `HotKids/Rules` under `snell/panel/`.\nIts upstream source is [`missuo/snell-panel`](https://github.com/missuo/snell-panel).', 'This panel is part of the `HotKids/Rules` Snell Toolkit and lives under `snell/panel/`.')
text = text.replace('# build the SPA + deploy the Worker (serves the SPA + API) from the repo root', '# build the SPA + deploy the Worker (serves the SPA + API) from the panel root')
panel_readme.write_text(text)

installer = Path('snell/panel/scripts/snell-install.sh')
text = installer.read_text()
text = text.replace('# Modeled on github.com/missuo/opensnell install.sh.', '# The optional opensnell variant uses its public release API.')
installer.write_text(text)
PY

rm -f .github/workflows/standalone-snell-toolkit.yml
rm -f .github/scripts/standalone-snell-toolkit.sh

git add -A

bash -n snell/snell-anytls.sh
bash -n snell/panel/scripts/snell-install.sh

if git diff --cached --quiet; then
  echo "No changes to commit"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "refactor: make snell toolkit standalone"
git push origin HEAD:master
