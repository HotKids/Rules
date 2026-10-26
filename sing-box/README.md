# sing-box

提供完整配置模板，以及 JSON、二进制两种格式的规则集。

## 使用完整配置

下载 [config.json](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/config.json)，按自己的设备和节点修改后导入。请使用支持 sing-box 1.12 配置格式的客户端。

使用前需要调整：

1. 替换 `outbounds` 中港、台、新、日、美的 Shadowsocks 示例节点。示例域名、端口和密码不能作为可用节点使用。
2. 如果更改节点的 `tag`，同步修改 `🇺🇳 Server`、地区组等出站选择器的引用。
3. 按系统和客户端的权限配置 TUN；不使用 TUN 时，可使用本机 `127.0.0.1:7890` 的 HTTP / SOCKS 混合代理入口。

请保存自己的配置副本。远程重新下载会替换完整文件，不能用于保存个人节点。

## 单独使用规则集

| 目录 | 引用时的 `format` | 说明 |
|---|---|---|
| [source/](source/) | `source` | JSON 文本，规则集版本为 2，便于查看内容 |
| [rule-set/](rule-set/) | `binary` | 同名 `.srs` 二进制文件 |

例如在自己配置的 `route.rule_set` 数组中添加 AI 服务规则集：

```json
{
  "tag": "genai",
  "type": "remote",
  "format": "binary",
  "url": "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/rule-set/GenAI.srs",
  "download_detour": "direct"
}
```

`download_detour` 必须引用自己配置中实际存在的出站 tag；本目录的完整模板使用 `🔘 Direct`。随后在路由规则中用 `rule_set: "genai"` 匹配，并指定需要的出站。

需要文本格式时，将 `format` 改为 `source`，URL 改为 [source/GenAI.json](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/source/GenAI.json)。

规则集与其他客户端的格式不同，应使用本目录对应文件。使用较新版本的 sing-box 时，请结合官方迁移说明检查本地配置是否需要调整。
