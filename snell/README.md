# Snell Toolkit

`snell/` 是 `HotKids/Rules` 里独立维护的 Snell Toolkit。现在只保留一个入口脚本：

- `snell-anytls.sh`：统一管理 Snell、ShadowTLS、AnyTLS、基础流量查看和 Snell Panel。
- `panel/`：面板源码目录，由 `snell-anytls.sh` 的 Snell Panel 菜单调用和管理。

本目录按当前代码独立维护，不再保留外部快照，不再自动同步外部脚本仓库。

## 统一入口脚本

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
- Snell Panel 依赖安装、本地变量写入、本地迁移、开发服务、构建和部署
- 查看当前节点配置
- 查看连接和监听端口

本脚本不使用 VLESS / REALITY / sing-box / Xray，并已移除 Snell v4，仅保留 Snell v5 / v6。

## 面板

面板源码直接放在 `snell/panel/`，作为普通源码目录维护。日常使用直接运行 `snell/snell-anytls.sh`，然后进入 `管理 Snell Panel`。

面板支持：

- Snell v5 / v6 节点管理
- 一次性安装命令
- Surge / Shadowrocket / Mihomo 订阅
- 节点启用、禁用、Relay 和升级

如果只想管理面板，不需要 root 权限：

```bash
bash snell/snell-anytls.sh
```

面板部署前仍需要按 `snell/panel/README.md` 创建 D1，并设置 `ACCESS_TOKEN` / `API_TOKEN`。

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
