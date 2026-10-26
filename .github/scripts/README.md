# 自定义与自动更新

使用本仓库配置、规则或模块时，直接在客户端导入对应文件的 Raw 地址即可，无需下载或运行本目录的脚本。各平台入口见[仓库首页](../../README.md)。

## 自动更新

| 内容 | 更新时间（北京时间） |
|---|---|
| 分流规则与单独模块 | 每天 00:07，以及仓库内相关配置变更后 |
| 去广告合集正式版 / Beta | 每天 00:27，以及仓库内相关配置变更后 |
| 各客户端配置 | 主配置或相关设置变更后 |
| 私人 Gist 配置 | 每天 12:00、配置更新成功后或手动运行 |

GitHub 定时任务可能延迟，客户端还需刷新远程资源才能取得新内容。某次同步失败时，已发布文件继续保留上一份版本；可在 [Actions](https://github.com/HotKids/Rules/actions) 查看最近运行结果。

## 在自己的仓库使用

先 Fork 本仓库并启用 GitHub Actions，再按自己的需求调整订阅、策略和模块。只修改生成后的文件会在后续同步时被覆盖；源文件位置及详细操作见[维护指南](MAINTENANCE.md)。

可在仓库的 Actions 页面选择相应任务，点击 **Run workflow** 手动更新。完整配置、覆写和模块的导入方式仍以各客户端使用说明为准。

## 生成私人 Mihomo / Stash 配置

`Sync Mihomo Gist` 可在同一个私密 Gist 中生成 `mihomo.yaml` 和 `stash.yaml`。两份文件使用同一份节点信息，只需维护 `mihomo.yaml` 中的节点。

1. 准备一个私密 Gist，添加 `mihomo.yaml`，至少包含 `proxies: []`，再填入自己的节点或 `proxy-providers`。公共配置和策略使用本仓库的 Mihomo 基座与 [MyScript 定制设置](sync-config/Enhanced/myscript.overlay.json)，先按自己的需求检查。
2. 在自己仓库的 **Settings → Secrets and variables → Actions** 中添加 `MIHOMO_GIST_ID`（Gist ID）和 `GIST_TOKEN`（具有 `gist` 权限的 classic PAT）。
3. 在 Actions 中运行 **Sync Mihomo Gist**。成功后，从该 Gist 取得两份配置的 Raw 地址，分别导入 Mihomo 和 Stash。

普通同步保留 `mihomo.yaml` 的顶层 `proxies` 与 `proxy-providers`，包括 Provider 名称和节点顺序；其余设置随基座更新。`stash.yaml` 自动复用这些节点，请在 `mihomo.yaml` 编辑。支持顶层节点、内联 Provider 和带 URL 的 HTTP Provider；本地 file Provider 无法跨设备复用。

编辑 Gist 本身不会立即触发同步，可手动运行任务，或等待每天北京时间 12:00 的定时更新。手动运行时的节点迁移、单行排版选项默认关闭，仅在需要整理节点时开启；具体用法见[维护指南中的 Gist 说明](MAINTENANCE.md#私人-mihomo-gist)。
