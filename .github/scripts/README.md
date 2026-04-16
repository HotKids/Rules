# .github/scripts

两个 Python 脚本（Python 3.12+，仅标准库），将 Surge 格式规则/配置自动同步到其他平台。

---

## `sync-rules.py` — 规则集同步

**源**：`Surge/RULE-SET/**/*.list`  
**目标**：`Quantumult/X/Filter/*.list`、`Clash/RuleSet/*.yaml`、`sing-box/source/*.json`

执行顺序：① 拉取 `sync-rules.txt` 中的外部 URL → ② 地区流媒体合集双向同步（按 mtime 决定方向） → ③ 重建 `Streaming.list` → ④ 格式转换 → ⑤ 清理孤立文件

**规则类型兼容性**

| 类型 | QX | Clash | sing-box |
|---|:---:|:---:|:---:|
| DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD | ✓ | ✓ | ✓ |
| IP-CIDR / IP-CIDR6 | ✓ | ✓ | ✓ |
| USER-AGENT | ✓ | — | — |
| AND / PROCESS-NAME | — | ✓ | ✓ |
| URL-REGEX | — | — | — |

**触发**：`Surge/RULE-SET/**` 或 `sync-rules.txt` 变动（push to master）；每天 UTC 16:00 定时

---

## `sync-config.py` — 配置文件同步

**源**：`Surge/Profile.conf`  
**目标**：`Clash/Sample.yaml`、`Surge/Balloon.lcf`（Loon）、`Quantumult/Sample.conf`、`Surge/Surfboard.conf`

各平台静态头部由 `sync-config/` 下的 ini 文件提供（支持 `<< path` / `<< https://url` 引用）。

**触发**：`Profile.conf`、`sync-config.py`、`sync-config.txt`、`sync-config/**` 变动（push to master）

### 各平台同步内容

| Surge 段 | Clash | Loon | QX | Surfboard |
|---|---|---|---|---|
| `[General]` | — | — | — | 白名单过滤（5 个 key） |
| `[Proxy]` | hidden wrapper group | `[Proxy]` | — | `[Proxy]` |
| `[Proxy Group]` | `proxy-groups:` | `[Proxy Group]` | `[policy]` | `[Proxy Group]` |
| `[Rule]` remote | `rule-providers:` + `rules:` | `[Remote Rule]` | `[filter_remote]` | — |
| `[Rule]` local | `rules:` | `[Rule]` + FINAL | `[filter_local]` | `[Rule]` |
| `[MITM]` | — | `[Mitm]` | `[mitm]` | — |

### 各平台跳过 / 转换

**Clash**
- 规则类型重命名：`DEST-PORT` → `DST-PORT`，`PROTOCOL,TCP/UDP` → `NETWORK,tcp/udp`
- 跳过：`URL-REGEX`、`USER-AGENT`、`PROTOCOL,QUIC`（无等价）

**Loon**
- Action proxy 映射：`reject-drop` → `REJECT-DROP`，其余 reject 变体 → `REJECT`
- smart 组通过 FilterMap 映射为 Loon FilterKey；无匹配则整组丢弃
- 跳过：`include-other-group`、`policy-path` 参数；非 HTTP URL 的本地规则

**QX**
- `Surge/RULE-SET/` URL 自动重映射为 `Quantumult/X/Filter/`
- icon-url 保留；组名默认剥除 emoji
- 跳过：`include-all-proxies=true` 类 group；GEOIP CN

**Surfboard**
- `[General]` 白名单：`dns-server`、`doh-server`、`skip-proxy`、`proxy-test-url`、`always-real-ip`
- `icon-url` 全部剥除；`REJECT-*` 变体统一归并为 `REJECT`
- `include-all-proxies=true` 组从 Profile.conf `//` 注释行读取替代定义
- 跳过规则类型：`URL-REGEX`、`USER-AGENT`、`GEOSITE`；无 `[MITM]` 输出

---

```bash
python .github/scripts/sync-rules.py
python .github/scripts/sync-config.py
```
