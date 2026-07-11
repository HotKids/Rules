# Surge

本目录是**全仓库的单一来源**：`Profile.conf` 与 `RULE-SET/` 手动维护，其余平台
（Clash / Loon / QX / Surfboard / sing-box）的配置和规则均由 `.github/scripts/`
下的同步脚本自动生成。

| 文件 / 目录 | 维护方式 | 说明 |
|---|---|---|
| `Profile.conf` | ✏️ 手动 | Surge 完整托管配置，**所有平台配置的单一来源**——改策略组 / 规则 / 通用设置只改这里 |
| `Sample.conf` | ✏️ 手动 | 通过 `#!include` 引用 `Profile.conf` 的示例入口 |
| `RULE-SET/` | ✏️ 手动 | 规则集单一来源，由 `sync-rules.py` 自动转换到 QX / Clash / sing-box |
| `ADVERTISING.list` | ✏️ 手动 | `🚧 AdGuard` 组的 `policy-path` 外部策略定义（REJECT 变体 + DIRECT）；文件内 `# icon:` 注释由 `sync-config.py` 读取，为 Clash 隐藏包装组套图标 |
| `Balloon.lcf` | 🤖 自动 | Loon 配置，由 `sync-config.py` 生成，改动会被下次同步覆盖 |
| `Surfboard.conf` | 🤖 自动 | Surfboard 配置，由 `sync-config.py` 生成，改动会被下次同步覆盖 |
| `Module/` | 混合 | sgmodule 模块，见下 |

## Module/

- **`BlockAds.sgmodule`** — 🤖 由 `sync-modules.py` 按 `sync-modules.txt` 的上游 URL
  列表聚合生成（按 section 合并、拼音排序、生成 `#!arguments` 逐 App 开关），改动会被下次同步覆盖；
  需搭配 `BlockAdsBase.sgmodule` 且保证其排序在前。
- **`BlockAdsBase` / `Bilibili` / `CloudMusic` / `RedNote` / `Weibo`** — 🤖 由
  `sync-rules.py` 按 `sync-rules.txt` 的 `# >> Module` 条目从上游镜像
  （`#!name` 等元数据可在条目内覆写），改动会被下次同步覆盖。
- **其余 `*.sgmodule`**（APNs / Client / GeoLoc / Profile / Rewrite / Task / VoWiFi /
  WeChat 等）— ✏️ 手动维护。
- **`Pannel/` + `Scripts/`** — ✏️ 手动维护的面板模块（机场流量 / IP 风险 / 流媒体解锁 /
  VPS 流量）及其配套脚本。

同步机制详见 [`.github/scripts/README.md`](../.github/scripts/README.md)。

