# 上游同步策略

本项目基于 `jinqians/snell.sh` 精简改造，目标是保留 Snell v5 / v6、ShadowTLS、流量管理和菜单公共逻辑，并新增本地 AnyTLS 管理能力。

本地新增的 AnyTLS 使用 `anytls-go` 官方二进制，配置和 systemd 服务由 `Rules/snell/snell-anytls.sh` 独立维护。

本项目不使用 VLESS / REALITY / sing-box / Xray。本项目已移除 Snell v4，只保留 Snell v5 / v6，默认 Snell 版本是 v6。

## 同步范围

上游同步只用于同步和参考以下内容：

- Snell v5 / v6
- ShadowTLS
- 流量管理
- 菜单公共逻辑

上游同步不得覆盖本地 AnyTLS 实现，不得重新引入 Snell v4，不得重新引入 VLESS / REALITY / sing-box / Xray。

## 同步脚本行为

`Rules/snell/sync-upstream.sh` 会：

1. 使用临时目录 clone `https://github.com/jinqians/snell.sh.git` 的 `main` 分支。
2. 将上游原始文件保存到 `Rules/snell/upstream/`。
3. 保存上游 commit 和同步时间，便于审查。
4. 运行 `bash -n Rules/snell/snell-anytls.sh`。
5. 运行 `bash -n Rules/snell/sync-upstream.sh`。
6. 如果系统安装了 `shellcheck`，则运行 shellcheck。
7. 检查禁止关键词没有进入主脚本代码逻辑。
8. 检查 AnyTLS 输出格式仍包含 AnyTLS URI、Surge 单行和 mihomo 单行 YAML。

`Rules/snell/upstream/` 目录只用于保存上游原始文件和对比，不代表主脚本实际启用。

## 人工审查要求

同步后必须检查 AnyTLS 输出格式是否仍包含：

- AnyTLS URI
- Surge 单行
- mihomo 单行 YAML

同步后必须检查禁止关键词没有进入主脚本代码逻辑。

如自动同步产生冲突，或者上游 Snell / ShadowTLS / 流量管理逻辑变化较大，需要人工处理 Pull Request。人工处理时只能把允许范围内的逻辑移植到 `Rules/snell/snell-anytls.sh`，不得直接用上游脚本整体覆盖本地主脚本。
