# mihomo 与 Stash

提供 mihomo 完整配置、订阅覆写和规则集，以及 Stash 配置覆写。这里的 mihomo 配置使用 Meta 内核功能，不适用于旧版 Clash 内核。

## mihomo：选择完整配置或订阅覆写

| 需求 | 使用地址 | 使用方式 |
|---|---|---|
| 完整配置 | [Sample.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Sample.yaml) | 下载为自己的配置，填写 `proxy-providers.Server.url` |
| 紧凑排版的完整配置 | [Mihomo.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Mihomo.yaml) | 与 Sample 功能等价，使用 YAML 锚点和单行排版 |
| 给已有订阅套用分组和规则 | [Script.js](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Script.js) | 添加到支持 `main(config)` 的客户端覆写脚本中，绑定有效订阅后启用 |

完整配置里的订阅地址是示例，需要替换为自己的地址。`proxies: []` 可用于手动填写节点，但默认节点池通过 `include-all-providers` 收集 Provider 节点；若将节点直接写进 `proxies`，还需要调整相关节点池，或改用订阅覆写脚本。

`Script.js` 支持节点直接位于 `proxies`、来自 `proxy-providers`，或两者混用；内联节点按原顺序筛选，不按名称重新排序。脚本会套用本仓库的基础设置、策略组和分流规则。出现“未找到任何代理节点”时，先检查绑定的订阅是否包含有效节点或 Provider。

默认启用的分流类别可通过脚本顶部 `ruleOptionsEnable` 开关调整。需要保留这些改动时，请保存自己的脚本副本，远程更新会替换文件内容。

完整配置默认使用 [MIPS TUN 网络栈](https://wiki.metacubex.one/config/inbound/tun/#stack)，需要 mihomo 1.19.31 或更新版本；建议使用 1.19.33 或更新版本。TUN 是否能启用还取决于客户端权限和系统支持。

## Stash：叠加到已有配置

导入 [Stash.stoverride](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Stash.stoverride)，并启用一份含有效节点的基础配置。

覆写保留基础配置的节点，替换 hosts、DNS、策略组、规则集和规则。地区分组根据节点名筛选，请确认节点名包含相应地区，例如 `HK`、`Hong Kong`、`香港`。DNS 查询按分流规则出站，节点域名使用独立 DNS 解析。

流媒体和 IP 卡片需要另行导入，不包含在配置覆写中：

- [流媒体与 AI 服务卡片](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/media-check-panel.stoverride)
- [IP 信息与风险卡片](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.stoverride)

卡片、通知与参数的用法见 [面板说明](../Surge/README.md#面板与-stash-卡片)。卡片与后台任务需要客户端提供相应功能。

## 个人定制版本

[MyScript.js](Script/MyScript.js)、[MyScriptColor.js](Script/MyScriptColor.js)、[MyClashBox.js](Script/MyClashBox.js)、[MyStash.stoverride](Script/MyStash.stoverride) 使用个人分组、节点筛选和规则设置。一般使用者优先选择通用版本；需要使用 `My*` 时，先检查地区、Relay 等分组是否能匹配自己的节点名。

需要自动生成自己的 Mihomo / Stash 配置时，可参考[自定义与自动更新](../.github/scripts/README.md)。

## 单独使用规则集

[RuleSet/](RuleSet/) 中的文件可作为远程规则集引用。请按配置中的 `behavior` 选择格式：

| 格式 | 适用场景 |
|---|---|
| `.yaml` | 文本规则；按内容选择 `domain`、`ipcidr` 或 `classical` |
| `.mrs` | mihomo 的二进制 `domain` / `ipcidr` 规则集，需使用 `format: mrs` |

例如将 [GenAI.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/GenAI.yaml) 添加为 `behavior: classical`、`format: yaml` 的 Provider，再在 `rules` 中通过 `RULE-SET,Provider名称,策略名` 引用。

Stash 应使用其支持的文本规则格式，不直接引用 mihomo 的 `.mrs` 文件。
