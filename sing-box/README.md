# sing-box

## 完整配置模板 `config.json`

对齐 sing-box **1.12+ 新格式**（typed DNS server、route rule action、`default_domain_resolver`、remote binary rule-set）的完整客户端配置，策略组 / 路由与本仓库 `Surge/Profile.conf` 一致：

- `route.rules` + `route.rule_set`：服务类规则集用本仓库 `rule-set/*.srs`，CN / geolocation 用 SagerNet 官方 `sing-geosite` / `sing-geoip`
- `dns` / `inbounds(tun+mixed)` / `experimental(clash_api+cache_file)` 全量落地
- 策略组 `selector`、地区组 `urltest` 镜像 Profile.conf

**节点需外部注入**：sing-box 无订阅机制，`outbounds` 必须是具体节点。模板里地区组 / `🇺🇳 Server` 组暂以占位出站 `🚀 Proxy（请用订阅工具注入节点）` 承载，请用订阅工具（机场的 sing-box 订阅 / sing-box-subscribe / subconverter 等）把真实节点加入 `outbounds`，并把地区/Server 组的 `outbounds` 替换为真实节点 tag。

> 注：`rule_set` 的 `download_detour: "direct"` 在 1.14 起标记 deprecated（替代项 `http_client` 仅 1.14+ 有）；为兼容 1.12/1.13 此处保留 direct 写法。CI（`lint.yml`）用 `sing-box check` 校验本文件结构。

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
