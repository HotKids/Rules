# mihomo 与 Stash

提供 mihomo 完整配置、订阅覆写、规则集及 Stash 覆写。mihomo 配置依赖 Meta 内核功能，不适用于旧版 Clash。

## mihomo：选择完整配置或订阅覆写

| 需求 | 使用地址 | 使用方式 |
|---|---|---|
| 完整配置 | [Sample.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Sample.yaml) | 下载后填写 `proxy-providers.Server.url` |
| 紧凑排版的完整配置 | [Mihomo.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Mihomo.yaml) | 与 Sample 功能等价，使用 YAML 锚点和单行排版 |
| 已有订阅叠加分组与规则 | [Script.js](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Script.js) | 在支持 `main(config)` 的客户端中添加脚本，绑定有效订阅 |

完整配置须替换示例订阅地址。默认节点池通过 `include-all-providers` 收集 Provider 节点；直接在 `proxies` 填写节点时，须调整节点池或使用覆写脚本。

`Script.js` 支持 `proxies`、`proxy-providers` 及混合来源，保留内联节点顺序，并应用本仓库设置、策略组及规则。提示“未找到任何代理节点”时，须检查绑定订阅是否包含有效节点或 Provider。

通过脚本顶部 `ruleOptionsEnable` 调整分流类别。远程更新会覆盖文件，定制脚本应另存副本。

完整配置默认使用 [MIPS TUN 网络栈](https://wiki.metacubex.one/config/inbound/tun/#stack)，需 mihomo 1.19.31 或更新版本，建议 1.19.33 及以上。TUN 还需系统支持及相应权限。

## Stash：叠加到已有配置

导入 [Stash.stoverride](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Stash.stoverride)，叠加至含有效节点的基础配置。

覆写保留节点，替换 hosts、DNS、策略组、规则集及规则。地区筛选依赖节点名，如 `HK`、`Hong Kong`、`香港`。DNS 按分流规则出站，节点域名独立解析。

流媒体及 IP 卡片须另行导入：

- [流媒体与 AI 服务卡片](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/media-check-panel.stoverride)
- [IP 信息与风险卡片](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Module/Pannel/ip-security-panel.stoverride)

卡片与后台任务需客户端支持，用法参见[面板说明](../Surge/README.md#面板与-stash-卡片)。

## 个人定制版本

[MyScript.js](Script/MyScript.js)、[MyScriptColor.js](Script/MyScriptColor.js)、[MyClashBox.js](Script/MyClashBox.js)、[MyStash.stoverride](Script/MyStash.stoverride) 包含个人分组、节点筛选及规则设置。使用 `My*` 前，须核对地区、Relay 等筛选条件与节点名称；通常建议使用通用版本。

自动生成定制配置，参见[自定义与自动更新](../.github/scripts/README.md)。

## 单独使用规则集

[RuleSet/](RuleSet/) 提供远程规则集，须匹配 `behavior` 与文件格式：

| 格式 | 适用场景 |
|---|---|
| `.yaml` | 文本规则；按内容选择 `domain`、`ipcidr` 或 `classical` |
| `.mrs` | mihomo 的二进制 `domain` / `ipcidr` 规则集，需使用 `format: mrs` |

例如 [GenAI.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/RuleSet/GenAI.yaml) 使用 `behavior: classical`、`format: yaml`，在 `rules` 中以 `RULE-SET,Provider名称,策略名` 引用。

Stash 支持 `domain`、`ipcidr` 类型的 MRS 规则集；`classical` 使用 YAML 或 text。配置方式参见 [Stash 官方文档](https://stash.wiki/rules/rule-set)。
