# sing-box rule-set

本目录提供 sing-box 规则集，两种格式并存，按需引用：

| 目录 | 格式 | `format` | 说明 |
|---|---|---|---|
| `source/*.json` | 源码 | `source` | 人类可读、可 diff 审查 |
| `rule-set/*.srs` | 二进制 | `binary` | 由 CI 用官方 `sing-box rule-set compile` 编译，体积更小、加载更快 |

两者内容等价，均声明 `version: 2`（需 sing-box ≥ 1.10）。`.srs` 由 `source/` 下同名 `.json` 自动编译，请勿手改；规则内容改动提交到 `Surge/RULE-SET/`（经 `sync-rules.py` 同步）。

## 引用示例

二进制（推荐终端用户使用）：

```json
{
  "tag": "geosite-genai",
  "type": "remote",
  "format": "binary",
  "url": "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/rule-set/GenAI.srs",
  "download_detour": "direct"
}
```

源码：

```json
{
  "tag": "geosite-genai",
  "type": "remote",
  "format": "source",
  "url": "https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/source/GenAI.json",
  "download_detour": "direct"
}
```
