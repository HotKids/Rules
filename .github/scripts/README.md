# 自定义与自动更新

配置、规则及模块通过 Raw 地址导入，无需运行本目录脚本。各平台入口见[仓库首页](../../README.md)。

## 自动更新

| 内容 | 更新时间（北京时间） |
|---|---|
| 分流规则与单独模块 | 每日 00:07，以及仓库内相关配置变更后 |
| 去广告合集正式版 / Beta | 每日 00:27，以及仓库内相关配置变更后 |
| 各客户端配置 | 主配置或相关设置变更后 |
| 私人 Gist 配置 | 每日 12:00、配置更新成功后或手动运行 |

GitHub 定时任务可能延迟，客户端需刷新远程资源。同步失败时保留已发布版本，运行结果见 [Actions](https://github.com/HotKids/Rules/actions)。

## 自建仓库

Fork 本仓库并启用 GitHub Actions，按需调整订阅、策略及模块。生成文件的直接修改会被后续同步覆盖，源文件位置及操作方法见[维护指南](MAINTENANCE.md)。

手动更新时，在 Actions 页面选择对应任务并点击 **Run workflow**。

## 生成私人 Mihomo / Stash 配置

`Sync Mihomo Gist` 在同一私密 Gist 中生成 `mihomo.yaml` 与 `stash.yaml`，统一使用前者的节点信息。

1. 创建私密 Gist，添加 `mihomo.yaml`，至少保留 `proxies: []`，并填写节点或 `proxy-providers`。其余配置使用本仓库 Mihomo 基座与 [MyScript 定制设置](sync-config/Enhanced/myscript.overlay.json)，使用前须核对。
2. 在仓库 **Settings → Secrets and variables → Actions** 添加 `MIHOMO_GIST_ID`（Gist ID）与 `GIST_TOKEN`（具有 `gist` 权限的 classic PAT）。
3. 运行 **Sync Mihomo Gist**，将生成文件的 Raw 地址分别导入 Mihomo 与 Stash。

普通同步保留 `mihomo.yaml` 的 `proxies`、`proxy-providers`、Provider 名称及节点顺序，其余设置随基座更新。节点仅在 `mihomo.yaml` 维护，`stash.yaml` 自动复用；支持顶层节点、内联及 HTTP Provider，不支持跨设备读取本地 file Provider。

Gist 编辑不触发即时同步，可手动运行或等待每日北京时间 12:00 更新。节点迁移及单行排版选项默认关闭，按需启用；详见[Gist 维护说明](MAINTENANCE.md#私人-mihomo-gist)。
