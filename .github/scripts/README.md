# .github/scripts

两个 Python 脚本，负责将 Surge 格式的规则/配置自动同步到其他平台。

---

## 脚本一：`sync-rules.py`

**职责**：规则集格式转换与双向同步

### 输入 / 输出

| 源 | 目标 |
|---|---|
| `Surge/RULE-SET/**/*.list` | `Quantumult/X/Filter/*.list`（QX 格式） |
| `Surge/RULE-SET/**/*.list` | `Clash/RuleSet/*.yaml`（`payload:` 格式） |
| `Surge/RULE-SET/**/*.list` | `sing-box/source/*.json` |
| `sync-rules.txt` 外部 URL | `Surge/RULE-SET/`（直接拉取写入） |

### 执行步骤

1. **拉取外部规则**：读取 `sync-rules.txt`，按平台 section 拉取远程 `.list` 写入本地
2. **地区合集双向同步**：`Streaming_JP` / `Streaming_TW` / `Streaming_US` 与各独立子项之间，按 mtime 决定方向（合集较新 → 拆出子项；子项较新 → 重建合集）
3. **重建 `Streaming.list`**：将全球流媒体子项按固定顺序合并
4. **格式转换**：Surge 规则 → QX / Clash / sing-box 各自格式（过滤各平台不支持的类型）
5. **清理**：删除源文件中已不存在的平台对应文件

### 规则类型兼容性

| 类型 | Surge | QX | Clash | sing-box |
|---|:---:|:---:|:---:|:---:|
| `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` | ✓ | ✓ | ✓ | ✓ |
| `IP-CIDR` / `IP-CIDR6` | ✓ | ✓ | ✓ | ✓ |
| `USER-AGENT` | ✓ | ✓ | — | — |
| `URL-REGEX` | ✓ | — | — | — |
| `AND` | ✓ | — | ✓ | ✓ |
| `PROCESS-NAME` | ✓ | — | — | ✓ |

### 配置：`sync-rules.txt`

```
# >> Surge          拉取到 Surge/RULE-SET/（子目录用斜杠指定，如 Apple/Apple）
https://example.com/foo.list,FileName

# >> Clash          拉取到 Clash/sing-box/（直接写入，跳过 Step 4 转换）
https://example.com/bar.yaml,FileName
```

### 触发

- `Surge/RULE-SET/**` 有改动时（push to master）
- `sync-rules.txt` 有改动时
- 每天 UTC 16:00（北京时间 00:00）定时

---

## 脚本二：`sync-config.py`

**职责**：将 Surge `Profile.conf` 同步为各平台完整配置文件

### 输入 / 输出

| 源 | 目标 |
|---|---|
| `Surge/Profile.conf` | `Clash/Sample.yaml` |
| `Surge/Profile.conf` | `Surge/Balloon.lcf`（Loon） |
| `Surge/Profile.conf` | `Quantumult/Sample.conf` |
| `Surge/Profile.conf` | `Surge/Surfboard.conf` |

各平台头部内容由 `sync-config/` 下对应 ini 文件提供。

### 生成逻辑

- **`[Proxy]`**：从 Surge `[Proxy]` 读取 action proxy（`direct` / `reject` 等），按各平台格式输出；Loon 需要独立的 `[Proxy]` 段，Clash 生成 hidden wrapper group
- **Proxy Groups**：遍历 Surge `[Proxy Group]`，跳过 `# > Skip` 指定的关键词；`select + policy-path`（无显式 proxies）的组识别为 adblock 组，自动填充 action proxy 列表
- **Rules / Rule Providers**：遍历 Surge `[Rule]`，URL 按 `# > Mapping` 替换；Clash 输出为 `rule-providers:` + `rules:`，Provider 名称按 `# > Rename` 重命名
- **静态头部**：每个平台从对应 ini 文件注入（`<< file` 引用本地文件；`<< https://...` 在对应 section 下抓取远程内容并内联同名 section）

### 配置：`sync-config.txt`

```
# Surge
>> Surge/Profile.conf       # 源文件路径
# > Skip
Keyword                     # 跳过含该关键词的 group / rule（全局）

# Clash
>> Clash/Sample.yaml        # 输出路径
# > Builtin
<< .github/scripts/sync-config/clash.ini   # 头部文件
proxy-groups:
  # 组描述 // AnchorGroupName   # 注入到该组之后
  - name: "..."
    ...
rules:
  # 规则描述 // AnchorRulePattern
  - RULE-SET,...
# > Skip
Keyword                     # 仅该平台跳过
# > Mapping
SrcURL => DstURL            # URL 替换（右侧留空 = 仅规范扩展名）
# > Rename
rule-providers:
  OldName => NewName        # Provider 重命名
```

### 平台头部 ini 文件（`sync-config/`）

| 文件 | 平台 |
|---|---|
| `clash.ini` | Clash Meta（含 proxy-providers、proxy-groups、rules 静态部分） |
| `loon.ini` | Loon（含 General、DNS、Remote Filter、Plugin 等段） |
| `qx.ini` | Quantumult X（含 general、dns、policy、filter_remote 等段） |
| `surfboard.ini` | Surfboard（含 General、Host 等段） |

ini 文件中可用 `<< path` 或 `<< https://url` 引用外部内容；URL 形式会在运行时抓取并仅提取与当前 section 同名的段落内联进来。

### 触发

- `Surge/Profile.conf` 有改动时（push to master）
- `sync-config.py` / `sync-config.txt` / `sync-config/**` 有改动时

---

## 本地运行

```bash
# 规则同步
python .github/scripts/sync-rules.py

# 配置同步
python .github/scripts/sync-config.py
```

依赖：Python 3.12+，仅用标准库，无需额外安装。

---

## 各平台同步内容详解

### Clash

| Surge 段 | Clash 输出 |
|---|---|
| `[Proxy]` | 动态生成 hidden action wrapper groups（`DIRECT` / `REJECT`） |
| `[Proxy Group]` | `proxy-groups:` |
| `[Rule]` | `rule-providers:` + `rules:` |

规则类型转换：`DEST-PORT` → `DST-PORT`，`PROTOCOL,TCP/UDP` → `NETWORK,tcp/udp`，`AND` 内子规则同步转换。

**跳过**：`URL-REGEX`、`USER-AGENT`；`PROTOCOL,QUIC`（无等价）；skip 关键词匹配的 group / rule；`direct` / `reject` 以外的 action proxy。

---

### Loon

| Surge 段 | Loon 输出 |
|---|---|
| `[Proxy]` | `[Proxy]`（仅 action proxy，`direct` → `DIRECT`，`reject-drop` → `REJECT-DROP`，其余 reject 变体 → `REJECT`） |
| `[Proxy Group]` | `[Proxy Group]`，smart 组映射为 FilterKey |
| `[Rule]` RULE-SET / DOMAIN-SET | `[Remote Rule]` |
| `[Rule]` FINAL 行 | `[Rule]` 末尾 |
| `[MITM]` | `[Mitm]`（ca-passphrase、ca-p12） |
| `loon.ini` 各段 | `[Host]` / `[Rewrite]` / `[Script]` / `[Plugin]` |

**跳过**：无 FilterMap 匹配的 smart 组（整组丢弃）；`include-other-group`、`policy-path` 参数（替换为 FilterMap / Builtin）；本地规则（非 HTTP URL 的 RULE-SET）。

---

### Quantumult X

| Surge 段 | QX 输出 |
|---|---|
| `[Proxy Group]` | `[policy]` |
| `[Rule]` RULE-SET / DOMAIN-SET | `[filter_remote]`，`Surge/RULE-SET/` 自动重映射为 `Quantumult/X/Filter/` |
| `[Rule]` GEOIP 非 CN、DEST-PORT、FINAL | `[filter_local]` |
| `[MITM]` | `[mitm]`（ca-passphrase、ca-p12） |
| `qx.ini` 各段 | `[server_remote]` / `[rewrite_remote]` / `[task_local]` 等 |

**跳过**：`include-all-proxies=true` 类 group（QX 不支持）；GEOIP CN（已在静态 filter_local）；skip 关键词匹配的 group / rule。

---

### Surfboard

| Surge 段 | Surfboard 输出 |
|---|---|
| `[General]`（白名单过滤） | `[General]`，仅保留 `dns-server`、`doh-server`、`skip-proxy`、`proxy-test-url`、`always-real-ip` |
| `[Proxy]` | `[Proxy]`（仅 action proxy） |
| `[Proxy Group]` | `[Proxy Group]`，`icon-url` 全部剥除 |
| `[Rule]` | `[Rule]`，不支持的类型过滤后直接输出 |

`include-all-proxies=true` 的组从 Profile.conf `//` 注释行读取替代定义（`policy-path=https://hotkids.me`）；无替代则丢弃。无 `[MITM]` 输出。

**跳过规则类型**：`URL-REGEX`、`USER-AGENT`、`GEOSITE`；`REJECT-TINYGIF` / `REJECT-DROP` / `REJECT-NO-DROP` 统一归并为 `REJECT`。

---

### 对比速览

| | Clash | Loon | QX | Surfboard |
|---|:---:|:---:|:---:|:---:|
| General | — | — | — | ✓（白名单） |
| Proxy（action） | wrapper group | ✓ | — | ✓ |
| Proxy Group | ✓ | ✓ | ✓ | ✓ |
| Rule → remote | rule-providers | Remote Rule | filter_remote | — |
| Rule → local | rules | Rule / FINAL | filter_local | Rule |
| MITM | — | ✓ | ✓ | — |
| URL-REGEX | ✗ | ✗ | ✗ | ✗ |
| USER-AGENT | ✗ | ✗ | ✓ | ✗ |
| GEOSITE | ✓ | ✓ | ✓ | ✗ |
| icon-url | ✓ | ✓（img-url） | ✓ | ✗ |
