# HotKids

自用规则、模块和代理工具集合。

`Surge/Profile.conf` 与 `Surge/RULE-SET/` 是唯一手动维护的配置 / 规则来源，
其他平台产物全部由 `.github/scripts/` 下的同步脚本自动生成——**改内容请改源头，直接改生成产物会被下次同步覆盖**。

| 目录 | 说明 |
|---|---|
| [`Surge/`](Surge/) | **单一来源**：托管配置 `Profile.conf`、规则源 `RULE-SET/`、sgmodule 模块 |
| [`Clash/`](Clash/) | 自动生成：`Sample.yaml` / `Mihomo.yaml`（锚点版）/ 规则集 / Enhance Script |
| [`Quantumult/`](Quantumult/) | 自动生成：QX 配置与规则；手动维护：图标库 `X/Images/` |
| [`sing-box/`](sing-box/) | 自动生成：完整配置 `config.json`、规则集（`source/` 源码 + `rule-set/` 二进制） |
| [`subconverter/`](subconverter/) | subconverter 订阅转换远程配置（已弃用，仅维护 emoji） |
| [`snell-panel/`](snell-panel/) | Snell / SS2022 节点管理面板（Cloudflare Workers + React） |
| [`.github/scripts/`](.github/scripts/) | 三个同步脚本（rules / modules / config）及其说明文档 |
