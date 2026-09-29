# Clash、mihomo 与 Stash

本目录提供完整配置、订阅覆写和规则集。配置产物由 Surge 主配置、平台基座与 overlay 生成；[General.yaml](General.yaml) 是手工维护的通用基础设置。

## 选择入口

| 需求 | 文件 | 说明 |
|---|---|---|
| mihomo 完整配置 | [Sample.yaml](Sample.yaml) | 常规排版，使用代理 Provider |
| mihomo 紧凑配置 | [Mihomo.yaml](Mihomo.yaml) | YAML 锚点与紧凑排版，内容与 Sample 等价 |
| mihomo 订阅覆写 | [Script.js](Script/Script.js) | 支持 `main(config)` 的客户端脚本入口；接收内联节点、Provider 或混合配置 |
| Stash 配置覆写 | [Stash.stoverride](Script/Stash.stoverride) | 叠加在已有节点配置上 |
| 个人定制 | [MyScript.js](Script/MyScript.js)、[MyScriptColor.js](Script/MyScriptColor.js)、[MyClashBox.js](Script/MyClashBox.js)、[MyStash.stoverride](Script/MyStash.stoverride) | 含个人筛选、地区分组与规则差异 |

远程导入使用 Raw 地址：[通用 JS](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Script.js)、[Stash 覆写](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Stash.stoverride)。`My*` 版本按个人节点命名和使用习惯定制，其中 JS 定制版依赖实际内联节点，使用前需检查筛选规则。

## Stash 的转换内容

Stash 覆写保留基础配置的节点，并替换 hosts、DNS、策略组、规则集与规则。示例 `proxy-providers` 整块注释停用，地区组通过 `include-all: true` 与 `filter` 从基础配置选节点。

- DNS 使用 `follow-rule: false`，保留域名分组的 nameserver-policy；移除 mihomo 的 `#RULES` 后缀与不适用字段。
- 境外 QUIC 使用 `PROTOCOL,QUIC` 及 `no-track`；国内域名/IP 的排除条件保留。
- Provider 层健康检查移除，由 url-test / fallback 策略组配置 `interval: 600`、`lazy: true`。
- mihomo 专属监听、控制面、TUN、嗅探及部分全局参数由转换器过滤。

检测卡片通过独立覆写导入：[流媒体/AI 服务 Tile](../Surge/Module/Pannel/media-check-panel.stoverride)、[IP 出口/本地/风险/类型 Tile](../Surge/Module/Pannel/ip-security-panel.stoverride)，并不包含在以上配置覆写中。详情见 [面板说明](../Surge/README.md#面板与脚本)。

## 规则集

[RuleSet/](RuleSet/) 的 YAML/TXT 来自手工规则转换或清单声明的上游。domain / ipcidr 规则另由 CI 编译同名 `.mrs`；classical 规则保留文本格式。修改规则内容时先确认来源，避免编辑会被覆盖的产物。

## 维护位置

| 修改内容 | 源文件 |
|---|---|
| 通用策略组与分流 | [Surge/Profile.conf](../Surge/Profile.conf) |
| Clash 基础设置 | [General.yaml](General.yaml)、[clash.ini](../.github/scripts/sync-config/clash.ini) |
| 映射、重命名与平台排除项 | [sync-config.txt](../.github/scripts/sync-config.txt) |
| `My*` 差异 | [Enhanced/*.overlay.json](../.github/scripts/sync-config/Enhanced/) |
| 转换逻辑 | [config_sync/](../.github/scripts/config_sync/) |

[同步脚本说明](../.github/scripts/README.md) 包含本地验证和发布流程。
