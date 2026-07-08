# Snell / ShadowTLS / AnyTLS 精简一键脚本

本目录提供一个基于 `jinqians/snell.sh` 风格精简改造的一键管理脚本，保留 Snell、ShadowTLS 和流量管理，并新增原生 AnyTLS 管理能力。

本脚本不使用 VLESS / REALITY / sing-box / Xray，并已移除 Snell v4，仅保留 Snell v5 / v6。

## 一键安装命令

本地运行：

```bash
chmod +x snell/snell-anytls.sh
sudo bash snell/snell-anytls.sh
```

远程运行：

```bash
bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/snell-anytls.sh)
```

## Snell 版本说明

本脚本已移除 Snell v4，仅保留 Snell v5 和 Snell v6。默认安装 Snell v6，用户可以在 Snell 管理菜单中切换到 Snell v5。

Snell 管理菜单支持：

- 安装/重装 Snell v6
- 安装/重装 Snell v5
- 切换 Snell 版本
- 更新当前 Snell
- 查看配置
- 修改端口
- 修改密码/PSK
- 启动、停止、重启、状态、日志
- 卸载

## Snell Panel

`snell/panel/` 已直接整合 `missuo/snell-panel` 源码，提供基于 Cloudflare Workers + D1 的 Snell 节点管理面板和订阅生成服务。

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

随后按 [`snell/PANEL.md`](PANEL.md) 和 [`snell/panel/README.md`](panel/README.md) 创建 D1、设置 `ACCESS_TOKEN` / `API_TOKEN` 并部署 Worker。

## AnyTLS 特性

- AnyTLS 使用 `anytls-go` 官方二进制。
- AnyTLS 不申请证书。
- AnyTLS 不要求必须有域名，可直接使用服务器公网 IP。
- AnyTLS 服务端由 systemd 管理，服务名为 `anytls.service`。
- AnyTLS 配置文件：`/etc/AnyTLS/config.yaml`。
- AnyTLS 客户端输出文件：`/etc/AnyTLS/client.txt`。
- AnyTLS 服务启动命令格式：`/etc/AnyTLS/server -l 0.0.0.0:<端口> -p "<密码>"`。

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

## 如何查看配置

运行：

```bash
sudo bash snell/snell-anytls.sh
```

然后选择：

```text
安装/管理 AnyTLS -> 查看 AnyTLS 配置
```

也可以在主菜单选择“查看所有节点配置”，脚本会依次尝试显示 Snell、ShadowTLS 和 AnyTLS 配置，未安装的项目会显示“未安装”。

## 如何更新 AnyTLS

运行脚本后选择：

```text
安装/管理 AnyTLS -> 更新 AnyTLS
```

更新过程会读取现有 `/etc/AnyTLS/config.yaml`，保留节点名称、服务器地址、端口、密码、SNI 和跳过证书校验设置，仅替换 AnyTLS 二进制并更新版本字段。

## 如何同步上游

手动同步：

```bash
bash snell/sync-upstream.sh
```

自动同步：

- GitHub Actions 工作流位于 `.github/workflows/sync-snell.yml`。
- 默认每周一 UTC 03:30 运行一次。
- 同步脚本只把上游原始文件保存到 `snell/upstream/` 供对比，不会直接覆盖 `snell/snell-anytls.sh` 的 AnyTLS 实现。
- 如有变更，工作流会创建 Pull Request，便于人工审查。

注意：`snell/sync-upstream.sh` 同步的是 `jinqians/snell.sh` 当前的 `main` 分支；本仓库默认分支仍为 `master`。

## 注意事项

- 需要手动确认 VPS 安全组放行 Snell、ShadowTLS 或 AnyTLS 对应 TCP 端口。
- 本脚本不关闭防火墙。
- 本脚本不清空防火墙规则。
- 本脚本会尽量通过 `firewalld` 或 `ufw` 添加单个 TCP 端口放行规则，但不会禁用防火墙。
- 生产环境请先在测试 VPS 上验证客户端兼容性。
