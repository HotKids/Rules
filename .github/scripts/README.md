# .github/scripts

三个同步脚本 + 共用模块 `_common.py`（Python 3.12+），将 Surge 格式规则/配置/模块自动同步到其他平台。
`sync-rules.py` 仅标准库；`sync-modules.py` 额外依赖 `pypinyin`（排序用）；
`sync-config.py` 额外依赖 `pyyaml`（解析 Sample.yaml 以生成 Mihomo.yaml 与 Script.js）。

---

## `sync-rules.py` — 规则集同步

**源**：`Surge/RULE-SET/**/*.list`  
**目标**：`Quantumult/X/Filter/*.list`、`Clash/RuleSet/*.yaml`、`sing-box/source/*.json`

执行顺序：① 拉取 `sync-rules.txt` 中的外部 URL → ② 地区流媒体合集双向同步（按 git diff 决定方向：HEAD commit + 工作区变更） → ③ 重建 `Streaming.list` → ④ 格式转换 → ⑤ 清理孤立文件

> sing-box 二进制规则集 `sing-box/rule-set/*.srs` 不由本脚本生成：`.srs` 只能用官方 sing-box CLI 编译，故在 `sync-rules.yml` workflow 里下载 sing-box 后对 `source/*.json` 执行 `rule-set compile` 得到，与 `.json` 并存一同提交。

**规则类型兼容性**

| 类型 | QX | Clash | sing-box |
|---|:---:|:---:|:---:|
| DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD | ✓ | ✓ | ✓ |
| IP-CIDR / IP-CIDR6 | ✓ | ✓ | ✓ |
| USER-AGENT | ✓ | — | — |
| AND / PROCESS-NAME | — | ✓ | ✓ |
| URL-REGEX | — | — | — |

**触发**：`Surge/RULE-SET/**`、`sync-rules.txt`、`sync-rules.py` 或 `_common.py` 变动（push to master）；每天 UTC 16:00 定时

---

## `sync-modules.py` — sgmodule 聚合

**源**：`sync-modules.txt` 中的上游 sgmodule URL 列表（可带 `#!name` 等元数据覆盖）
**目标**：`Surge/Module/BlockAds.sgmodule`（按 section 聚合、拼音排序、生成 `#!arguments` 开关）

**触发**：`Surge/Module/**`、`sync-modules.txt`、`sync-modules.py` 或 `_common.py` 变动（push to master）；每天 UTC 16:00 定时

---

## `sync-config.py` — 配置文件同步

**源**：`Surge/Profile.conf`  
**目标**：`Clash/Sample.yaml`、`Clash/Mihomo.yaml`、`Clash/Script/Script.js`、`Clash/Script/MyScript.js`、`Clash/Script/MyClashBox.js`、`Clash/Script/MyScriptColor.js`、`Surge/Balloon.lcf`（Loon）、`Quantumult/Sample.conf`、`Surge/Surfboard.conf`、`sing-box/config.json`

各平台静态头部由 `sync-config/` 下的 ini 文件提供（支持 `<< path` / `<< https://url` 引用）。sing-box 完整配置以 `sync-config/sing-box.ini`（JSON 内容）为静态基座——仅保留 `sniff`/`hijack-dns`（sing-box 专属基础设施，Surge 无等价规则）；`route.rules`/`route.rule_set` 其余全部（含 QUIC 拦截、SSH 直连、私有网络、CN/geo、各服务分流）从 `[Rule]` 生成后 splice 进哨兵位——自有清单用本仓库 `.srs`，Loyalsoldier/VirgilClyne 等外部规则集映射到 SagerNet 官方等价规则集。

`Clash/Mihomo.yaml` 是 `Clash/Sample.yaml` 生成完毕后转译出的锚点/flow 版（功能等价）：
公共参数抽成 YAML 锚点（`&Remote` 规则集参数、`&Region` 地区分组基座、`&Filter<码>`
地区正则），条目单行紧凑排版；地区组由 `use:[Server]+filter` 改写为
`<<: *Region, filter: *Filter<码>`（`include-all-providers` 与 `use:` 同走 mihomo
保序路径，功能一致）。

`Clash/Script/Script.js` 是 `Clash/Mihomo.yaml` 生成完毕后再解析出来的等效 mihomo 覆写
脚本（Enhance Script），供 Clash Verge 等客户端直接对任意订阅动态生成同一套策略组 /
规则 / 基础设置，无需依赖本仓库自身的 proxy-providers。它只读 Mihomo.yaml 的解析结果、
不重新实现转换逻辑，因此随 `Profile.conf` 改动自动同步，禁止手改。地区组 / `🇺🇳 Server`
组不用 mihomo 的 `include-all` / `include-all-proxies`（它对候选节点做隐式字母序排序，
无开关可关，见 `_gen_clash_script_js` 注释）：订阅里的内联节点由运行时按
`poolGroupFilters` 手动过滤 `config.proxies` 填入并保持订阅原始顺序；订阅只给
`proxy-providers` 时则回退到组上预置的 `include-all-providers` + `filter`（provider
路径同样保序），两种形态及混合订阅均兼容。三个 My* 私人定制版仍要求订阅含真实
内联节点（纯手动填充）。脚本会保留订阅里的机场私有 DNS / 节点域名 hosts
（覆盖 dns/hosts 前采集、覆盖后合并），规则集公共参数抽成 `remoteRuleProvider` 常量以
`...spread` 复用（与 Mihomo.yaml 的 `&Remote` 锚点互为镜像）。

`Clash/Script/MyScript.js`、`Clash/Script/MyClashBox.js`、`Clash/Script/MyScriptColor.js`
都是 `Script.js` 的私人定制版：
在同一套自动生成基座上，各自叠加 `sync-config/Enhanced/` 下同名的 `*.overlay.json`
声明的差异（`rename_map` 批量改名、`icon_overrides` 批量换图标、`remove_groups` 整组
删除、`group_overrides` 类型/filter 覆盖、`group_proxies_insert` 候选节点插入、
`extra_pool_groups` 额外分组、`move_after` 调整展示顺序、`disabled_by_default` 让部分
分组默认关闭），因此公共部分（rules/rule-providers/基础设置、以及未被 overlay 覆盖的
分组）随 `Profile.conf` 自动同步，私人差异集中改对应的 `*.overlay.json` 即可，禁止手改
这两个生成产物本体。overlay 还可以用 `extends: "<其他 overlay 文件名>"` 声明基于另一份
已生成的 overlay 结果继续叠加（链式：`clashbox.overlay.json` extends
`myscriptcolor.overlay.json` extends `myscript.overlay.json`，图标继承自 MyScriptColor），
只需要写与被继承者的差异，公共部分（地区 fallback、Relay 中转链等）不必重复声明。

`_sync_clash` 会自动扫描 `Enhanced/` 下所有 `*.overlay.json`，每份的输出路径由它自己的
`output` 字段声明（仓库根相对，如 `"Clash/Script/MyClashBox.js"`），`extends` 依赖顺序自动
拓扑解析——因此**新增一份个人配置只需在 `Enhanced/` 下放一个带 `output` 的 `*.overlay.json`
即可自动生成对应脚本，无需改动 `sync-config.py`**。改某份 overlay 的 `output` 后，旧路径上
遗留的脚本会在下次同步时自动清理（仅删带生成标记的产物，不碰手放的其它 `.js`）。

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
- 规则类型重命名：`DEST-PORT` → `DST-PORT`，`PROTOCOL,TCP/UDP` → `NETWORK,TCP/UDP`
- 跳过：`URL-REGEX`、`USER-AGENT`、`PROTOCOL,QUIC`（无等价）

**Loon**
- Action proxy 映射：`reject-drop` → `REJECT-DROP`，其余 reject 变体 → `REJECT`
- `[Remote Filter]` 条目全部自动生成（单点源 Profile.conf）：smart 组的
  `policy-regex-filter` → `Filter<码>`（如 FilterHK），`include-all-proxies` 组 →
  全节点 FilterUN；`loon.ini` 只留段头，`sync-config.txt` 的 FilterMap 仅作手动覆盖
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
