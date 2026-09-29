# Surge、Loon 与 Surfboard

本目录保存 Surge 主配置、规则和模块，同时承载自动生成的 Loon、Surfboard 配置。

## 配置入口

| 文件 | 维护方式 | 用途 |
|---|---|---|
| [Sample.conf](Sample.conf) | 手动 | 引用主配置的示例入口 |
| [Profile.conf](Profile.conf) | 手动 | 跨平台生成器的主要配置来源 |
| [ADVERTISING.list](ADVERTISING.list) | 手动 | AdGuard 的外部策略定义；图标注释也供生成器读取 |
| [Balloon.lcf](Balloon.lcf) | 自动 | Loon 配置 |
| [Surfboard.conf](Surfboard.conf) | 自动 | Surfboard 配置 |

导入请使用对应文件的 Raw 地址，并按自己的环境配置订阅、节点与个人策略。Loon、Surfboard 的平台差异在 [同步基座](../.github/scripts/sync-config/) 中维护。

## 规则与去广告模块

[RULE-SET/](RULE-SET/) 包含手工规则、上游镜像和 Streaming 聚合表。上游镜像的来源、命名及排除域名在 [sync-rules.txt](../.github/scripts/sync-rules.txt) 中声明，直接编辑镜像内容会被后续下载覆盖。

Streaming 成员以 `### Streaming` 或 `### Streaming US` 等标记声明归属。通常修改对应服务文件；也支持编辑总表或地区表。同一次修改请避免同时改动互不一致的总表与成员，生成器遇到冲突会停止覆盖。

[Module/BlockAds.sgmodule](Module/BlockAds.sgmodule) 按 [sync-modules.txt](../.github/scripts/sync-modules.txt) 聚合生成，需搭配 [BlockAdsBase.sgmodule](Module/BlockAdsBase.sgmodule)，基础模块排序在前。`BlockAdsBase`、`Bilibili`、`CloudMusic`、`RedNote`、`Weibo` 等镜像模块的来源与元数据覆盖项在 `sync-rules.txt` 的 Module 段维护。其余模块按文件自身说明使用。

## 面板与脚本

面板入口保留在历史目录名 [Pannel/](Module/Pannel/)，JavaScript 统一放在 [Scripts/](Module/Scripts/)。

| 面板 | 入口 | 配置重点 |
|---|---|---|
| 机场流量 | [airport-traffic-panel.sgmodule](Module/Pannel/airport-traffic-panel.sgmodule) | 订阅链接、到期日与重置日 |
| IP 风控 | [ip-security-panel.sgmodule](Module/Pannel/ip-security-panel.sgmodule) | 地理/风控数据源、可选 API Key、通知与 IP 打码 |
| Komari 流量 | [komari-traffic-panel.sgmodule](Module/Pannel/komari-traffic-panel.sgmodule) | 面板地址、可选 token、节点筛选与展示项 |
| 流媒体与 AI | [media-check-panel.sgmodule](Module/Pannel/media-check-panel.sgmodule) | 多行汇总、价格与状态通知 |
| Stash 服务 Tile | [media-check-panel.stoverride](Module/Pannel/media-check-panel.stoverride) | 每项服务一张卡片，与 Surge 共用检测 JS |

流媒体检测包含 Netflix、Disney+、HBO Max、YouTube Premium、Spotify、ChatGPT、Gemini、Claude、Reddit。Surge 可额外启用 Viu；Stash 不包含 Viu。ChatGPT 保留一个服务结果，区分地区、Web Only、Mobile Only 与 NO。

Stash 卡片默认折叠在第三方服务页面；如需放到首页，将对应 Tile 的 `collapsed` 改为 `false`，并将 `argument` 中的 `mode=collapsed` 改成 `mode=home`。可用时显示品牌底色，不可用或检测异常时显示灰色。卡片点击 URL 同时定义在覆写与 JS 中，检测完成后以 JS 返回值为准；是否打开 App 还取决于系统链接关联。

参数详情以模块的 `#!arguments-desc` 和脚本注释为准。IP 风控接口全部失败时显示“未知”，不会用固定评分冒充检测结果。friDay 签到脚本仅在确认成功或已签到后记录当天完成状态。

生成、验证和故障处理见 [同步脚本说明](../.github/scripts/README.md)。
