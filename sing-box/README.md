# sing-box

提供完整配置模板，以及 JSON、二进制两种格式的规则集。

## 使用完整配置

使用支持 sing-box 1.12 配置格式的客户端，下载并调整 [config.json](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/config.json) 后导入。

使用要求：

1. 替换 `outbounds` 中的 Shadowsocks 示例节点；示例域名、端口及密码不可直接使用。
2. 修改节点 `tag` 时，同步调整 `🇺🇳 Server`、地区组等出站引用。
3. TUN 须具备系统及客户端权限；亦可使用 `127.0.0.1:7890` 的 HTTP / SOCKS 混合代理入口。

个人配置须另存副本；远程更新会覆盖节点及本地修改。

## 单独使用规则集

| 目录 | 引用时的 `format` | 说明 |
|---|---|---|
| [source/](source/) | `source` | JSON 文本，规则集版本为 2 |
| [rule-set/](rule-set/) | `binary` | 同名 `.srs` 二进制文件 |

在 `route.rule_set` 数组中添加 AI 服务规则集：

```json
{
  "tag": "genai",
  "type": "remote",
  "format": "binary",
  "url": "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/rule-set/GenAI.srs",
  "download_detour": "direct"
}
```

`download_detour` 须引用已有出站 tag；本目录模板使用 `🔘 Direct`。随后以 `rule_set: "genai"` 匹配并指定出站。

使用文本格式时，将 `format` 改为 `source`，URL 改为 [source/GenAI.json](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/source/GenAI.json)。

须使用本目录对应格式；升级 sing-box 时，应参照官方迁移说明核对配置。
