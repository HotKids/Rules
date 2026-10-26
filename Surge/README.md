# Surge、Loon 与 Surfboard

提供分流配置、规则集、去广告模块和检测面板。配置中的订阅、节点及个人设置需要按自己的环境填写。

## 选择配置

| 客户端 / 用途 | 导入地址 | 使用前需要调整 |
|---|---|---|
| Surge 示例配置 | [Sample.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Sample.conf) | 将 `[Proxy]` 中的 `Subscription.conf` 换成自己的本地订阅文件名 |
| Surge 主配置 | [Profile.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Profile.conf) | 添加节点，检查 DNS、局域网访问和个人策略 |
| 已有 Surge 配置增加通用设置 | [Profile.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Profile.sgmodule) | 在模块参数中填写当前配置的代理、直连和拒绝策略名 |
| Loon | [Balloon.lcf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Balloon.lcf) | 在 `[Remote Proxy]` 填写并启用自己的订阅 |
| Surfboard | [Surfboard.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Surfboard.conf) | 将 `🇺🇳 Server` 的 `policy-path` 换成自己的订阅地址 |

表中的链接均为 Raw 地址，可复制到对应客户端导入。需要长期保留本地改动时，请保存为自己的配置；重新下载完整配置会替换文件内容。

Surge 示例通过 `#!include` 引用主配置，可以保留独立的订阅文件。需要 MITM 时，请在客户端生成并信任自己的证书，替换示例证书。

`Profile.sgmodule` 提供通用设置、Host 和开头至 Bogus 的分流规则，不包含节点、策略组、脚本或 MITM。参数 `PROXY`、`DIRECT`、`REJECT` 默认分别为 `🔰 Proxy`、`🔘 DIRECT`、`⛔️ REJECT`；自己的配置没有这些策略时需要修改参数。

Surge 主配置和 Profile 模块使用 HTTPS 测速地址，需支持该功能的版本（iOS 5.23 / Mac 6.10 起）。QUIC 按节点的 `block-quic` 设置处理；新内核的 `auto` 可自适应回落 TCP，DIRECT 不拦截。Loon、Surfboard 应使用各自的配置入口，不能直接照搬 Surge 的全部参数。

## 去广告

先导入 [BlockAdsBase.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/BlockAdsBase.sgmodule)，再从以下两份合集中选择一份，基础模块的优先级放在合集之前。

| 模块 | 说明 |
|---|---|
| [BlockAds.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/BlockAds.sgmodule) | 收录自 [QingRex/LoonKissSurge](https://github.com/QingRex/LoonKissSurge) 的去广告合集 |
| [BlockAdsBeta.sgmodule](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/BlockAdsBeta.sgmodule) | Beta 合集，适合愿意测试更新规则的使用者 |

合集默认启用所收录的 App。需要停用某个 App 时，将模块参数中该 App 的域名关键字改为 `NO` 等非常见域名值；其他功能开关按参数说明设置。部分 App 需要清除缓存或重新安装后才生效。

[Module/](Module/) 还提供单独的 App 模块。按模块说明启用所需的脚本、重写和 MITM，避免同时加载功能重复的合集与单独模块。

## 面板与 Stash 卡片

| 用途 | Surge 模块 | Stash 覆写 |
|---|---|---|
| IP、地区与风险检测 | [IP Security Monitor](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.sgmodule) | [IP Security Tiles](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.stoverride) |
| 流媒体与 AI 服务检测 | [Streaming & AI Service Monitor](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/media-check-panel.sgmodule) | [Streaming & AI Service Tiles](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/media-check-panel.stoverride) |
| 机场流量 | [Airport Traffic](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/airport-traffic-panel.sgmodule) | — |
| Komari 流量 | [Komari Traffic](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/komari-traffic-panel.sgmodule) | — |

导入后按模块参数填写订阅链接、面板地址等信息。IP 和流媒体面板可直接使用默认免密钥检测；Surge 的部分数据源允许另填 API Key，Stash 不提供需要第三方 API Key 的选项。

### IP 检测

显示直连公网 IP、代理出口、地区、运营商及风险信息。Surge 可显示实际代理策略等额外信息；Stash 提供首页 IP 信息卡，以及出口、本地、纯净度三张折叠卡片。首页卡片需要客户端支持首页 Tile。

数据源可在参数中选择首选，失败后继续回退。Stash 的免密钥风险来源为 IPPure → ProxyCheck → Scamalytics；具体可选来源、打码和旗帜设置以导入时的参数表为准。接口结果缺失或异常时可能显示未知，不能据此认定 IP 一定属于某种类型。

检测请求遵循当前分流，不同探测域名可能使用不同出口。比较检测结果时，请先确认所用策略和 IP 一致。

Stash 的 IP 变化通知默认开启，首次成功检测建立基线，此后每 10 分钟检查一次。需要 Stash 保持连接、允许通知，并支持后台脚本；如果日志提示 `script runtime is unavailable on this platform`，该客户端暂不能运行通知任务，卡片检测仍可使用。

### 流媒体与 AI

默认检测 Netflix、Disney+、HBO Max、YouTube Premium、Spotify、TikTok、ChatGPT、Claude、Gemini、Meta AI、Reddit，共 11 项。Surge 可额外开启 Viu；Stash 保留 11 张独立卡片。

结果显示可用地区或状态：`No` / `NO` 表示明确受限，`TO` 表示超时，`Error` 表示本次响应无法确认。检测反映当前请求的结果，服务的账号、订阅套餐或浏览器验证仍可能影响实际使用。检测方式参考 [Stash 官方示例](https://github.com/StashNetworks/misc/tree/main/collapsed-tiles) 与 [UnlockTests](https://github.com/oneclickvirt/UnlockTests/tree/main/transnation)。

Netflix 价格显示和解锁变化通知可在参数中开关。Stash 的通知独立于卡片，默认关闭；开启后每 10 分钟检查，首次只记录基线，超时和错误不作为状态变化通知。

Stash 卡片默认折叠在第三方服务页面。需要将流媒体卡片移到首页时，在自己的覆写副本中同时设置 `collapsed: false` 和 `mode=home`。两份覆写的脚本日志分别汇总到 `hotkids-ip-security.log`、`hotkids-media-check.log`，通常最多延迟一分钟。

## 单独使用规则集

[RULE-SET/](RULE-SET/) 提供 Surge 规则集。选中所需 `.list` 文件，复制 Raw 地址，在自己的配置中用 `RULE-SET,链接,策略名` 引用即可；策略名必须已存在于当前配置。

Loon、Surfboard 的支持范围与 Surge 不同。使用完整配置时请选上面的对应入口；只引用规则时，也要确认客户端支持其中的规则类型。
