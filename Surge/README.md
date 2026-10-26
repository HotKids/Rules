# Surge、Loon 与 Surfboard

提供分流配置、规则集、去广告模块及检测面板。订阅、节点和个人设置须按使用环境调整。

## 选择配置

| 客户端 / 用途 | 导入地址 | 使用前需要调整 |
|---|---|---|
| Surge 示例配置 | [Sample.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Sample.conf) | 将 `[Proxy]` 中的 `Subscription.conf` 替换为本地订阅文件名 |
| Surge 主配置 | [Profile.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Profile.conf) | 添加节点，检查 DNS、局域网访问和个人策略 |
| Surge 通用设置模块 | [Profile.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Profile.sgmodule) | 填写当前配置的代理、直连和拒绝策略名 |
| Loon | [Balloon.lcf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Balloon.lcf) | 在 `[Remote Proxy]` 填写并启用订阅 |
| Surfboard | [Surfboard.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Surfboard.conf) | 替换 `🇺🇳 Server` 的 `policy-path` 订阅地址 |

表内均为 Raw 导入地址。完整配置更新会覆盖本地修改，定制内容应另存副本。

Surge 示例通过 `#!include` 引用主配置，订阅可独立保存。启用 MITM 前，须生成、安装并信任证书，替换示例证书。

`Profile.sgmodule` 包含通用设置、Host 及开头至 Bogus 的分流规则，不含节点、策略组、脚本和 MITM。`PROXY`、`DIRECT`、`REJECT` 默认值为 `🔰 Proxy`、`🔘 DIRECT`、`⛔️ REJECT`，须与当前配置的策略名一致。

Surge 主配置及 Profile 模块使用 HTTPS 测速，需 Surge iOS 5.23 / Mac 6.10 或更新版本。QUIC 遵循节点的 `block-quic` 设置；新内核的 `auto` 支持自适应回落 TCP，DIRECT 不拦截。Loon、Surfboard 须使用对应配置。

## 去广告

> **去广告规则及脚本由对应上游项目维护，本仓库仅作收录、同步及格式适配。去广告效果或脚本逻辑问题，请向对应上游仓库反馈，来源见模块注释。**

导入 [BlockAdsBase.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/BlockAdsBase.sgmodule)，并选择以下一份合集；基础模块优先级须高于合集。

| 模块 | 说明 |
|---|---|
| [BlockAds.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/BlockAds.sgmodule) | 收录自 [QingRex/LoonKissSurge](https://github.com/QingRex/LoonKissSurge) 的去广告合集 |
| [BlockAdsBeta.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/BlockAdsBeta.sgmodule) | 测试版合集，供验证更新规则使用 |

合集默认启用全部收录 App。停用单个 App 时，将其域名关键字参数改为 `NO` 等非常见域名值；其余开关参见参数说明。部分 App 需清除缓存或重新安装。

[Module/](Module/) 提供单独的 App 模块。按说明启用脚本、重写及 MITM，避免重复加载相同功能。

## 面板与 Stash 卡片

| 用途 | Surge 模块 | Stash 覆写 |
|---|---|---|
| IP、地区与风险检测 | [IP Security Monitor](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.sgmodule) | [IP Security Tiles](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.stoverride) |
| 流媒体与 AI 服务检测 | [Streaming & AI Service Monitor](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/media-check-panel.sgmodule) | [Streaming & AI Service Tiles](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/media-check-panel.stoverride) |
| 机场流量 | [Airport Traffic](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/airport-traffic-panel.sgmodule) | — |
| Komari 流量 | [Komari Traffic](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/komari-traffic-panel.sgmodule) | — |

按模块要求填写订阅链接、面板地址等参数。IP 与流媒体检测默认无需密钥；Surge 部分数据源支持 API Key，Stash 不提供第三方 API Key 选项。

### IP 检测

显示直连公网 IP、代理出口、地区、运营商及风险信息。Surge 另提供代理策略等信息；Stash 提供首页信息卡及出口、本地、纯净度三张折叠卡片，首页需客户端支持 Tile。

可通过参数指定首选数据源，失败后自动回退。Stash 风险来源顺序为 IPPure → ProxyCheck → Scamalytics；其他来源、打码及旗帜选项参见参数表。未知结果表示信息缺失或异常，不代表确定的 IP 类型。

检测请求遵循当前分流，探测域名可能使用不同出口；比较结果前须确认策略及 IP 一致。

Stash IP 变化通知默认开启，每 10 分钟检查，首次成功检测仅建立基线。须保持连接、允许通知并支持后台脚本；日志出现 `script runtime is unavailable on this platform` 时，通知任务不可用，卡片仍可检测。

### 流媒体与 AI

默认检测 Netflix、Disney+、HBO Max、YouTube Premium、Spotify、TikTok、ChatGPT、Claude、Gemini、Meta AI、Reddit，共 11 项。Surge 另可启用 Viu；Stash 提供 11 张独立卡片。

结果显示地区或状态：`NO` 为明确受限，`TO` 为超时，`ER` 为响应无法确认或请求错误。实际使用还受账号、订阅及浏览器验证影响。检测参考 [Stash 官方示例](https://github.com/StashNetworks/misc/tree/main/collapsed-tiles) 与 [UnlockTests](https://github.com/oneclickvirt/UnlockTests/tree/main/transnation)。

参数支持 Netflix 价格与解锁变化通知。Stash 通知独立运行，默认关闭；启用后每 10 分钟检查，首次仅建立基线，超时及错误不触发变化通知。

Stash 流媒体卡片默认位于第三方服务页面。移至首页时，须在覆写副本中同时设置 `collapsed: false` 与 `mode=home`。日志分别保存至 `hotkids-ip-security.log`、`hotkids-media-check.log`，通常延迟不超过一分钟。

## 单独使用规则集

复制 [RULE-SET/](RULE-SET/) 中所需 `.list` 文件的 Raw 地址，以 `RULE-SET,链接,策略名` 引用；策略须已存在于当前配置。

Loon、Surfboard 单独引用规则时，须确认客户端支持所含规则类型。
