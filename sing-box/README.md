# sing-box

提供完整配置模板及源码、二进制两种规则集。配置与规则均由仓库同步流程生成。

## 完整配置

[config.json](config.json) 使用 sing-box 1.12 系列的新格式，包括 typed DNS、路由 action 和远程二进制规则集。CI 固定用 **1.12.0** 执行 `sing-box check`，这表示结构校验通过，不代表已完成各设备上的联网测试。

导入入口：[config.json 的 Raw 地址](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/config.json)。文件中的港、台、新、日、美 Shadowsocks 节点是占位示例，不能直接作为可用节点。使用前需要替换具体出站节点，并同步调整 `🇺🇳 Server` 与地区组引用。

通用策略与路由来自 [Surge/Profile.conf](../Surge/Profile.conf)，sing-box 基础设置来自 [sing-box.ini](../.github/scripts/sync-config/sing-box.ini)。转换代码位于 [config_sync/singbox.py](../.github/scripts/config_sync/singbox.py)；直接编辑生成文件会被下次同步覆盖。

## 规则集

| 目录 | `format` | 用途 |
|---|---|---|
| [source/](source/) | `source` | JSON 源码，便于阅读和审查 |
| [rule-set/](rule-set/) | `binary` | CI 从同名 JSON 编译的 `.srs` |

规则集源码声明 `version: 2`；CI 使用官方 `sing-box rule-set compile` 生成二进制，并清理没有对应源码的孤立文件。规则内容在 [Surge/RULE-SET/](../Surge/RULE-SET/) 或 [sync-rules.txt](../.github/scripts/sync-rules.txt) 的上游清单维护。

以下对象放入配置的 `route.rule_set` 数组；`download_detour` 需引用自己配置中实际存在的出站 tag：

```json
{
  "tag": "genai",
  "type": "remote",
  "format": "binary",
  "url": "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/rule-set/GenAI.srs",
  "download_detour": "direct"
}
```

若需要源码格式，将 `format` 改为 `source`，URL 改成 [source/GenAI.json](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/source/GenAI.json)。

编译版本、验证与发布流程见 [维护说明](../.github/scripts/README.md)。
