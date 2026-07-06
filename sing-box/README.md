# sing-box

## 完整配置 `config.json`

对齐 sing-box **1.12+ 新格式**（typed DNS server、route rule action、`default_domain_resolver`、remote binary rule-set）的完整客户端配置。由 `sync-config.py` 从 `Surge/Profile.conf` 自动生成（静态基座见 `.github/scripts/sync-config/sing-box.ini`），策略组 / 路由与其他平台一致，请勿手改。

**节点**：sing-box 无订阅机制，`outbounds` 必须是具体节点。已内置港/台/新/日/美 5 个示例 Shadowsocks 节点（`hk/tw/sg/jp/us.hotkids.me`，仅供占位，非真实可用凭据），可直接改 `server`/`password` 试用；正式使用请用订阅工具（机场 sing-box 订阅 / sing-box-subscribe / subconverter 等）替换 `🇺🇳 Server` 与各地区组的 `outbounds`。

---

## 规则集

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
