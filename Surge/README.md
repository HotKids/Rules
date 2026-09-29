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
| Stash IP Tile | [ip-security-panel.stoverride](Module/Pannel/ip-security-panel.stoverride) | 风险、DNS、出口、本地四张首页卡片 |
| Stash 服务 Tile | [media-check-panel.stoverride](Module/Pannel/media-check-panel.stoverride) | 每项服务一张卡片，与 Surge 共用检测 JS |

流媒体检测包含 Netflix、Disney+、HBO Max、YouTube Premium、Spotify、ChatGPT、Gemini、Claude、Reddit。Surge 可额外启用 Viu；Stash 不包含 Viu。ChatGPT 保留一个服务结果，区分地区、Web Only、Mobile Only 与 NO。

Stash 流媒体卡片默认折叠在第三方服务页面；如需放到首页，将对应 Tile 的 `collapsed` 改为 `false`，并将 `argument` 中的 `mode=collapsed` 改成 `mode=home`。可用时显示品牌底色，不可用或检测异常时显示灰色。卡片点击 URL 同时定义在覆写与 JS 中，检测完成后以 JS 返回值为准；是否打开 App 还取决于系统链接关联。

IP 风控的 Surge 和 Stash 版本共用 [ip-security.js](Module/Scripts/ip-security.js)。两者默认本地地理源为百度、出口地理源为 `ipapi-zh`；Surge 保留数据源选项，已有模块参数需自行检查是否仍保存旧值。

Stash [IP 覆写 Raw 地址](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.stoverride) 导入后，首页按 **风险 → DNS → 出口 → 本地** 排列，每 600 秒刷新。风险固定使用 IPPure，评分和住宅/机房、原生/广播信息取自同一次请求；接口失败时显示灰色，不回落到其他评分源。其余三张卡片使用固定底色，主要检测失败时变灰。卡片图标使用 [Koolson/Qure](https://github.com/Koolson/Qure) 的 `IconSet/Color/` 彩色 Hijacking / Round_Robin / Global / Domestic，覆写主图标为彩色 Lock。

Stash 已预设不打码、台湾旗帜和开启通知。首次成功检测只记录基线，此后由出口卡片在刷新时通知 IP 变化；这依赖客户端执行 Tile 与通知权限，不是 Surge 的 `network-changed` 即时事件。临时查询失败不作为 IP 变化，其他卡片不重复通知。若手动改为折叠模式，需同时设置 `collapsed: true` 和 `mode=collapsed`，此模式不通知。

本地卡片检测的是直连公网 IP；DNS 卡片显示探测到的解析器及地区，不能单凭地区判断是否泄露。请求默认遵循当前分流，不同探测站点可能走不同出口，因此风险卡片同时显示 IPPure 实际检测的 IP。Stash 不显示依赖 Surge 专用接口的入口 IP、实际策略名称和流量统计。覆写中的 `argument` 只负责卡片分工，无需导入时选择参数。

参数详情以模块的 `#!arguments-desc` 和脚本注释为准。IP 风控接口全部失败时显示“未知”，不会用固定评分冒充检测结果。friDay 签到脚本仅在确认成功或已签到后记录当天完成状态。

生成、验证和故障处理见 [同步脚本说明](../.github/scripts/README.md)。
