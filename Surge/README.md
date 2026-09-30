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
| Stash IP Tile | [ip-security-panel.stoverride](Module/Pannel/ip-security-panel.stoverride) | 出口、本地、IP 纯净度三张折叠卡片 |
| Stash 服务 Tile | [media-check-panel.stoverride](Module/Pannel/media-check-panel.stoverride) | 每项服务一张卡片，与 Surge 共用检测 JS |

流媒体检测按 Netflix、Disney+、HBO Max、YouTube Premium、Spotify、TikTok、ChatGPT、Claude、Gemini、Meta AI、Reddit 排列，共 11 项。Surge 可额外启用 Viu；Stash 不包含 Viu。ChatGPT 保留一个服务结果，区分地区、Web Only、Mobile Only 与 NO。App 探测根路径的通用 `cf_details` 响应不作为地区封锁；Web 正常且 trace 有效时保留地区结果，明确的地区或 ISP 限制仍按原规则处理。Meta AI 优先从 Meta 官网地区路径获取地区，也支持主页地区字段；可用但无地区时显示 OK。TikTok 从 Explore 页面读取地区，未知时尝试主页；香港停止服务页面（包括 `/hk/about`）显示 NO。

明确受限显示 NO；超时显示 Timeout，限流和其他无法确认的响应显示 Error，不新增验证页等状态文案。Claude 遇到浏览器挑战时，可依据 trace 中已知受支持的地区回落显示地区；该回落表示地区支持，不代表已完成浏览器验证或账号登录。未知状态不触发解锁失效通知。Spotify 优先读取播放器 market；Gemini 正确转换三位地区码；Netflix 在确认影片页面后判断可用性，另测原创影片确认 Originals Only，缺地区时不默认美国。YouTube 使用明确的 Premium 标记，通常只请求一次，未知时才用 Cookie 回落。Netflix 价格表缓存 24 小时，更新最多等待 2 秒，失败可使用之前缓存。

检测判据参考 [Stash 官方示例](https://github.com/StashNetworks/misc/tree/main/collapsed-tiles) 和 [UnlockTests](https://github.com/oneclickvirt/UnlockTests/tree/main/transnation)。采用网页地区、结构化字段及明确限制信息，适配 Surge / Stash 的 HTTP 接口；不依赖命令行工具或额外 DNS 解锁类型探测。ViuCom 即可选的 Viu，支持最终重定向地区与 no-service 判据。

Stash 流媒体卡片默认折叠在第三方服务页面；如需放到首页，将对应 Tile 的 `collapsed` 改为 `false`，并将 `argument` 中的 `mode=collapsed` 改成 `mode=home`。可用时显示品牌底色，不可用或检测异常时显示灰色。卡片点击 URL 同时定义在覆写与 JS 中，检测完成后以 JS 返回值为准；是否打开 App 还取决于系统链接关联。

IP 风控的 Surge 和 Stash 版本共用 [ip-security.js](Module/Scripts/ip-security.js)。两者默认本地地理源为百度、出口地理源为 `ipapi-zh`；Surge 保留数据源选项，已有模块参数需自行检查是否仍保存旧值。

Stash [IP 覆写 Raw 地址](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.stoverride) 导入后，支持首页 Tile 的客户端会显示一张 **IP 信息卡**，使用 [IPPure Logo](https://ippure.com/logo.png)。卡片按 **IP 风控值 → IP 类型 → 本地 IP → 出口 IP** 排列，区块之间留空行；地区与运营商各占一行并保留完整信息。风控值以百分比显示，沿用折叠版阈值：低于 40 为低风险、40 至小于 70 为中风险、70 及以上为高风险；整张卡片对应绿、黄、红底色，评分无效时灰色。出口同时有 IPv4 / IPv6 时使用 `出口 IP⁴`、`出口 IP⁶` 两行标签，只有 IPv4 时显示 `出口 IP`；地址内部不插入换行，长文本仍可能被客户端自动折行。首页每 600 秒并行检测各项，一项失败不清空其他有效结果，与折叠卡片共享同 IP 的有效历史字段，卡片本身不发送通知。

原有三张独立卡片继续折叠在第三方服务页面（Android 为“流媒体”），按 **出口 → 本地 → IP 纯净度** 排列，每 600 秒刷新。IP 纯净度固定使用 IPPure，一次请求同时取得风险评分与 IP 类型：第一行结果显示“住宅/机房 · 原生/广播”，第二行显示“分数 / 100 · 风险等级”，不重复显示出口 IP。这里仍是 IPPure 原始风险分，数值越低风险越低，不做反转。评分或分类缺失时，先按本次 IPPure 响应确认的 IP 复用 24 小时内上次成功的对应字段；没有同 IP 的有效缓存时才显示灰色或未知，不回落到其他风险数据源。

出口为深蓝，本地为青绿；两张卡片检测失败时变灰。IP 纯净度按低、中、高风险分别显示绿、黄、红色。出口和本地把 IP 放在标题第二行，正文保留“地区 · 运营商”；为适配 Android 折叠卡片的单行正文，纯净度把类型放在标题下方，风险值放在正文。出口、本地、纯净度卡片分别使用 selfh.st 的 [Drasl](https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/drasl-light.png)、[Target](https://cdn.jsdelivr.net/gh/selfhst/icons/png/target-light.png)、[AdGuard Home Central Manager](https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/adguard-home-central-manager-light.png) 浅色 PNG；覆写主图标使用 [selfh.st / cAdvisor PNG](https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/cadvisor.png)。出口和纯净度卡片点击后打开 IPPure 首页；本地卡片检测成功后，通过 `https://ippure.com/?ip=本地公网IP` 查询卡片显示的直连公网 IP，首页与折叠模式均支持。未取得本地 IP 或开启打码时，跳转到 IPPure 首页。

Stash 已预设不打码、台湾旗帜和开启 IP 变化通知。独立的 `hotkids-ip-security-notify` 定时任务每 10 分钟检查一次日常分流下的本地与出口 IP，首次成功取得的字段各自建立基线，此后只通知确认的变化；一项查询失败不阻止其他 IP 的有效变化通知。通知接口缺失或调用抛出异常时保留旧基线，下一次检查重试。任务需要客户端支持后台脚本运行、Stash 保持连接并有通知权限，不是 Surge 的 `network-changed` 即时事件。若 Android 任务日志出现 `script runtime is unavailable on this platform`，表示该版本尚不支持此后台任务，仅启用覆写不能发送通知；Tile 检测不受此限制。

卡片与通知记录分开，长按测试节点不会覆盖日常监测基线，也不会触发网络变化通知。更新至 6.3.0 需同时更新覆写以安装定时任务；如需关闭通知，将 `cron.script` 中该任务的 `notify=true` 改为 `notify=false`。支持首页 Tile 的客户端可同时设置 `collapsed: false` 和 `mode=home`，通知任务不受卡片布局影响。

折叠出口卡片只检测显示所需的 IPv4，首页模式额外获取 IPv6；IPv4 返回后立即启动地区与运营商查询。地理信息按 IP 和数据源缓存 6 小时、最多保留 32 条，实时出口与 IPPure 评分不使用此缓存。三张卡片另按卡片类型和已确认 IP 保存上次成功字段，最多保留 32 组、24 小时；刷新缺失字段优先复用同一 IP 的历史结果，保留原文字和背景色，不显示缓存标记，只记日志。字段分别保留原始更新时间，失败刷新不续期；新 IP 的失败不会覆盖旧 IP 的成功记录。无法取得本次 IP 时不套用上次结果；纯净度只认 IPPure 本次返回的 IP，不拿 Cloudflare 出口代替。地区与运营商查询最多等待 5 秒：本地优先百度，失败后使用本次直连 IP 响应自带的 Bilibili 地区或同一 IP 的 ip.sb 信息；出口优先 ip-api 中文，失败后复用 ipinfo 的 HTTPS 地区，再回退到探测响应已有的国家信息。回退不额外发起 IP 探测，不借用其他出口的地区，也不把缺失的城市或运营商补成已知值。旗帜查询最多等待 1 秒，失败不影响已取得的本地地区。所有 IP 卡片的图标统一在覆写中配置。

本地卡片检测的是直连公网 IP。请求默认遵循当前分流，不同探测站点可能走不同出口，风险和类型反映 IPPure 探测请求的结果。Stash 不显示依赖 Surge 专用接口的入口 IP、实际策略名称和流量统计。覆写中的 `argument` 只负责卡片分工，无需导入时选择参数。

参数详情以模块的 `#!arguments-desc` 和脚本注释为准。IP 风控接口全部失败时显示“未知”，不会用固定评分冒充检测结果。friDay 签到脚本仅在确认成功或已签到后记录当天完成状态。

生成、验证和故障处理见 [同步脚本说明](../.github/scripts/README.md)。
