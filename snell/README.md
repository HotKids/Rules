# Snell Toolkit

`snell/` 是 `HotKids/Rules` 里独立维护的 Snell Toolkit。现在以 Panel 为主入口：

- `panel/`：Snell Panel 源码和部署入口，负责节点开通、升级、订阅和日常管理。
- `panel/scripts/snell-install.sh`：由 Panel 生成命令并通过 `/install.sh` 下发到 VPS 的节点开通器。
- `snell-anytls.sh`：保留为独立 VPS 备用脚本，不再作为 Panel 工作流入口。

本目录按当前代码独立维护，不再保留外部快照，不再自动同步外部脚本仓库。

## 推荐工作流

部署并登录 Panel：

```bash
cd snell/panel
bun install
# 按 snell/panel/README.md 创建 D1 并设置 ACCESS_TOKEN / API_TOKEN 后：
bun run deploy
```

随后在 Panel 中添加节点，复制面板生成的一次性命令到 VPS 执行。VPS 上执行的是 Panel 托管的 `/install.sh`，它会完成 Snell 安装、systemd 服务、端口放行尝试、TFO 设置，并把 `ip/port/psk` 注册回 Panel。

Panel 工作流支持：

- Snell v5 / v6 节点开通
- 节点升级到 Snell v6
- 节点启用、禁用、Relay 和删除
- Surge / Shadowrocket / Mihomo 订阅
- 订阅 token 轮换

Panel 安装器不使用 VLESS / REALITY / sing-box / Xray，并已移除 Snell v4，仅保留 Snell v5 / v6。

## 面板

面板源码直接放在 `snell/panel/`，作为普通源码目录维护。部署前需要按 `snell/panel/README.md` 创建 D1，并设置 `ACCESS_TOKEN` / `API_TOKEN`。

## 备用脚本

`snell-anytls.sh` 仍保留给不部署 Panel 的场景使用，可独立安装 Snell、ShadowTLS、AnyTLS 和查看基础流量。Panel 工作流不依赖它。

远程运行备用脚本：

```bash
bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/snell-anytls.sh)
```

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
