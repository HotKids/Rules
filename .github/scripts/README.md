# 同步与维护

本目录将配置、规则和模块生成到各客户端目录。生成提交前执行统一验证；上游下载不完整时停止发布，保留 GitHub 上的上一份完整产物。

## 维护入口

| 需要调整的内容 | 源文件 |
|---|---|
| 通用策略组、路由及 Surge 设置 | [Surge/Profile.conf](../../Surge/Profile.conf) |
| Mihomo 与 Stash 共用的通用设置（模式、日志、Hosts、DNS 等） | [Clash/General.yaml](../../Clash/General.yaml) |
| 平台输出路径、排除项、URL 映射、重命名 | [sync-config.txt](sync-config.txt) |
| 各平台静态基座 | [sync-config/](sync-config/) 的 ini 文件 |
| Profile 增强模块的元数据、参数与合并操作符 | [profile-module.ini](sync-config/profile-module.ini) |
| `My*` 私人差异 | [sync-config/Enhanced/](sync-config/Enhanced/) 的 overlay JSON |
| 手工规则与 Streaming 成员 | [Surge/RULE-SET/](../../Surge/RULE-SET/) |
| 上游规则及镜像模块 | [sync-rules.txt](sync-rules.txt) |
| BlockAds 聚合来源与参数别名 | [sync-modules.txt](sync-modules.txt) |
| 面板及检测实现 | [Pannel/](../../Surge/Module/Pannel/) 与 [Scripts/](../../Surge/Module/Scripts/) |

## 本地命令

环境：Python 3.12+、Node.js 20+。在仓库根目录运行：

```bash
python3 -m pip install -r .github/scripts/requirements.txt
python3 .github/scripts/validate.py
```

`validate.py` 离线检查 Python/JS 语法、YAML/JSON、Sample/Mihomo 等价性、Tile provider 对应关系，并执行 Python 回归与面板模拟测试。

```bash
# 完整重生配置后验证，会访问远程 include
python3 .github/scripts/validate.py --regenerate

# 分别执行生成器，会修改工作区
python3 .github/scripts/sync-config.py
python3 .github/scripts/sync-rules.py
python3 .github/scripts/sync-modules.py
```

SRS/MRS 编译与 sing-box 完整配置检查由工作流调用官方内核执行，本地 `validate.py` 不代替这些步骤。JavaScript 测试使用模拟响应，不会进行真实签到或发送通知。

## 配置生成

[sync-config.py](sync-config.py) 保留命令入口，实际实现按职责拆分：

| 模块 | 职责 |
|---|---|
| [parser.py](config_sync/parser.py) | 平台清单、基座与 Surge 源解析 |
| [common.py](config_sync/common.py) | 路径、公共分组/规则工具与输出格式 |
| [profile_module.py](config_sync/profile_module.py) | Surge Profile 增强模块，保留模块参数和列表合并方式 |
| [clash.py](config_sync/clash.py) | Clash/Mihomo YAML、增强 JS 和结构化 overlay |
| [stash.py](config_sync/stash.py) | Stash 转译及保留注释的 overlay |
| [loon.py](config_sync/loon.py)、[qx.py](config_sync/qx.py)、[surfboard.py](config_sync/surfboard.py)、[singbox.py](config_sync/singbox.py) | 各平台输出 |
| [pipeline.py](config_sync/pipeline.py) | 按依赖顺序组织生成 |

产物包括 `Surge/Module/Profile.sgmodule`、`Clash/Sample.yaml`、`Mihomo.yaml`、`Clash/Script/` 的 JS/Stash 覆写、`Surge/Balloon.lcf`、`Surge/Surfboard.conf`、`Quantumult/Sample.conf` 和 `sing-box/config.json`。没有实质变化时保留原时间戳，避免空提交。

`Profile.sgmodule` 从 `Surge/Profile.conf` 同步 `[General]`、`[Host]`，以及 `[Rule]` 开头至 `Bogus`（含）的一整段规则，仅排除标准 SSH 端口规则。Bypass、Reroute、Private 和 HTTPDNS 等内容保留源中的启用状态、顺序及附加选项；Ponte、节点、策略组、脚本、MITM 和 `Bogus` 后续规则不生成。[profile-module.ini](sync-config/profile-module.ini) 单独维护元数据、参数、`[Rule Selection]` 的结束边界和 `[General]` 的 `%APPEND%` / `%INSERT%` 操作符。参数声明为 `PROXY:Proxy,DIRECT:Direct,REJECT:Reject`；`[Rule Policy]` 将对应策略映射到参数，`Bogus` 仍保留 `REJECT-DROP`。域名列表默认追加，DNS、开关和端口等普通设置覆盖。主配置、生成器及模板都已处于 `Sync Config` 的触发范围内；工作流会提交生成后的模块，修改产物本身不会反向修改主配置或模板。

`Pannel/` 内已有同名 `.stoverride` 的面板，其顶层 `category`、`icon` 由 `.sgmodule` 的 `#!category`、`#!icon` 同步。只在 Surge 源文件维护这两个字段，修改会触发 `Sync Config`；源中删除或留空也会移除 Stash 对应字段。卡片内部的图标、名称、描述及布局仍由 Stash 面板维护。

两份面板还从 `#!arguments` 读取 Stash 支持的参数默认值，直接写入对应脚本的 `argument`，不输出 Surge 参数编辑占位符或 `#!arguments-desc`。IP 面板同步数据源、凭据、打码与旗帜，`notify` 用于定时通知任务；`risk_api=null` 保留脚本在 Stash 上默认使用 IPPure 的行为。流媒体面板的 `nfprice`、`geminiapikey` 分别用于 Netflix、Gemini；折叠卡片关闭通知，日志收集任务不接收检测参数。Surge 专用的 `event_delay`、`panel_interval`、`viu` 不搬入 Stash，Tile 刷新周期继续由 `interval` 配置。

### 平台清单

`sync-config.txt` 按平台分块：

| 写法 | 含义 |
|---|---|
| `# Platform` | 平台名称 |
| `>> path` | 源文件或输出文件 |
| `# > Skip` | 排除关键词；Surge 块中为全局排除项 |
| `# > Builtin` | 平台基座与注入内容 |
| `<< path` / `<< https://...` | 引入本地文件或远程内容 |
| `# > Mapping` | URL 映射 |
| `# > Rename` | 策略/Provider 名称映射 |
| `# > Gist` | Raw 地址的反代设置 |

Builtin 中的 `# 说明 // 关键词` 以段落注释为插入锚点；规则块支持多段锚点。具体格式和现有例子在清单顶部说明中保留。远程 include 下载失败即中止生成。

### 私人 overlay

通用脚本为 `Clash/Script/Script.js`。`Enhanced/*.overlay.json` 通过 `output` 声明定制 JS 路径，支持继承、改名、图标、分组覆盖/插入、额外节点池、规则插入和默认关闭项。以当前 overlay 文件为可用字段示例，不直接修改生成后的 `My*` 文件。

声明 `stash_output` 的 overlay 还生成定制 Stash 覆写。Stash 没有 JS 运行时开关，`disabled_by_default` 会移除对应组、路由和候选引用，并清理失去引用的规则集。遇到 Stash 尚未支持的 overlay 字段会报错，避免静默遗漏。

Mihomo 与 Stash 的通用设置以 `Clash/General.yaml` 为共同上游：`clash.ini` 引入 General，生成 `Clash/Sample.yaml` 后派生 `Mihomo.yaml`、Mihomo JS 覆写和两份 Stash 覆写。Mihomo YAML 和 JS 按当次上游输出全部通用字段，新增字段无需修改生成器中的字段表；节点、策略组、规则集及路由等结构块仍按各自流程处理。Stash 沿用可共用的源字段（如 `mode`、`log-level`、`hosts`、`proxy-hosts`）并适配 DNS 等差异，不另设固定值。修改 General 已在 `sync-config.yml` 的 push 触发范围内；直接修改生成产物会在下次同步时被覆盖。私人 overlay 只叠加它声明的差异。

Stash DNS 在 [stash.py](config_sync/stash.py) 按 [Stash 内置 DNS 文档](https://stash.wiki/features/dns-server)适配，保留 Clash/Mihomo 源中的主 DNS、引导 DNS、私网/NTP/国内域名策略、节点域名 DNS 和 `fake-ip-filter`，不另选主 DNS。源中的 `respect-rules: true` 或普通解析器的 `#RULES` 转为 Stash 的 `follow-rule: true`；没有规则路由要求时保持 `false`。当前源使用 Cloudflare `https://1.1.1.1/dns-query#RULES`，Stash 输出同一 DoH 地址并开启 `follow-rule`，让 DNS 请求按现有规则出站。腾讯/阿里 DoH 仍用于国内域名和独立的 `proxy-server-nameserver`；后者不会跟随代理规则，避免节点域名解析递归。

Stash 官方 DNS 文档定义了 `#h3=true`，未提供 Mihomo 的 `#RULES` / `#策略名` 服务器后缀语法，转换时移除策略后缀、保留 HTTP/3 选项。`#RULES` 的功能由全局 `follow-rule` 适配，指定策略名的逐服务器路由不能等价保留；源配置混用跟随规则与直接出站的解析器时，也不能仅凭这个全局开关保证逐服务器等价。逗号拼接的 policy 键拆成独立域名；Stash 的 policy 按精确域名、通配域名、geosite 的优先级匹配，同级 geosite 使用配置顺序。Mihomo 的 `direct-nameserver` / `direct-nameserver-follow-policy` 没有 Stash 官方文档中的等价配置，因此不输出；对境外域名手动选择 DIRECT 时，两者可能使用不同解析器。DNS 子键中的监听、解析模式、缓存参数、IPv6 与 Fake IP 地址池也因未确认可等价沿用而省略；这不影响已保留的顶层 `mode`。

Stash 通用字段的取舍以[官方配置样例](https://stash.wiki/configuration/example-config)、[主机名映射](https://stash.wiki/features/hosts)及相关功能文档为依据。LAN 代理、TCP 并发、TUN 和嗅探有明确功能证据，但未据此假定 Mihomo 同名 YAML 参数可等价生效；这些未获官方 YAML 文档确认的源参数暂不搬入覆写。省略字段不代表 Stash 缺少该能力，也不代表已证实字段被忽略。`proxies` 是主动省略的例外，使用户基础配置中的节点得以继承；`proxy-hosts` 是独立的代理域名映射字段，不与 `hosts` 合并。

源中的顶层 `ipv6: false` 和 DNS 的 `ipv6: false` 均不输出，不能声称 Stash 已继承 Mihomo 禁用 IPv6 的效果。[官方 IPv6 文档](https://stash.wiki/faq/ipv6-compatible)说明 Stash 通常根据系统网络自动选择 IPv4/IPv6；「启用 Tunnel IPv6 路由」管理隧道路由，不能视为上述源开关的等价替代。

Stash 基座转换保留可沿用的源内容、注释与排版：境外 QUIC 改为 `PROTOCOL,QUIC` / `no-track`，Provider 健康检查交给策略组的 `interval: 600` / `lazy: true`。主要设置块使用 `#!replace`。

两份 Stash 配置覆写的 MITM 证书由同一 `Sync Config` 工作流同步：`Surge/Profile.conf` 的 `[MITM] ca-p12` → `http.ca`，`ca-passphrase` → `http.ca-passphrase`。`MyStash.stoverride` 从基座继承同一证书，不另维护副本。`http` 按子键合并，保留基础配置及其他覆写中的 MITM 域名、重写和脚本；按官方示例放在通用设置之后、Hosts/DNS/代理与规则之前，内部采用 force-http-engine、ca、ca-passphrase、mitm 的顺序；同时将模板 `[General]` 实际声明的 `force-http-engine-hosts` 同步为 `http.force-http-engine`，域名和端口表达式保持原值并去重，参照 [Stash 强制 HTTP 引擎文档](https://stash.wiki/http-engine/force-http-engine)。只转换模板已有的受支持字段；没写的设置不补入，不转译模块域名或 `h2`、`skip-server-cert-verify`。字段依据 [Stash MITM 文档](https://stash.wiki/http-engine/mitm)，设备仍须安装并信任对应 CA。修改或删除源字段后重新生成，两份产物都会跟随更新；同步日志不输出证书和密码。

自有 LAN 的下载地址由 `sync-config.txt` 的 Builtin Mapping 声明。生成器将 Fastly 的 LAN 分支地址固定为对应规则产物最后一次提交的版本，避免 CDN 分支缓存继续返回旧地址段；工作区产物未提交或无法取得 Git 历史时停止生成，不发布旧版本。Sync Rules 成功发布编译产物后会触发 Sync Config，未来上游修改会同步到新的不可变地址。其本地缓存文件名包含 `Surge/RULE-SET/LAN.list` 有效规则的摘要：地址段变化会生成新缓存路径，避免客户端继续载入旧 LAN 规则；仅修改注释或空行不会换版本。Mihomo、JS 和 Stash 继承同一地址与缓存路径。生成配置需要完整 Git 历史（`fetch-depth: 0`）。

## 规则同步

[sync-rules.py](sync-rules.py) 依次拉取外部规则与镜像模块、处理 Streaming 双向同步、转换 QX/Clash/sing-box 格式、清理不再需要的产物。

### 上游清单

`sync-rules.txt` 支持 Surge、Clash、Module 段：

```text
URL,名称
DOMAIN-SET,URL,名称
URL,名称 #!remove=a.example,b.example
```

`DOMAIN-SET` 声明裸域名 / 域名后缀来源；转换后使用各平台相应语义。`#!remove` 从镜像中剔除指定域名，同名多来源合并去重。Module 段可覆盖 `#!name`、`#!desc`、`#!author`、`#!category`、`#!icon`、`#!arguments`。分类和图标保留在 Surge 模块，并同步到 Stash 顶层字段；Stash 将规则、重写、脚本及 MITM 中的参数占位符按默认值展开，不附带 Surge 参数编辑说明。同名来源合并时，描述性元数据取第一份，参数保留各来源的独有默认值、同名参数取第一份。

上游镜像按清单维护，直接编辑下载产物会被覆盖。遇到来源迁移，请修改清单；需要删除某个来源时显式删除条目，不把下载失败当成上游内容已删除。

### Streaming 双向同步

成员文件用以下标记声明是否参与总表、地区表：

```text
### Streaming
### Streaming US
```

优先修改服务成员文件。若只编辑 `Streaming.list` 或某个 `Streaming_<地区>.list`，生成器会先提取回成员，再重建合集；无地区标记和合并文件的全部 section 都会保留。

- push 通过 `SYNC_BASE_SHA`（事件 before）到实际检出 HEAD 的完整差异决定方向，`SYNC_EVENT_SHA` 验证触发提交仍在当前历史中，覆盖多提交与排队期间的新修改。
- 总表/地区表与对应成员同时修改且内容不一致时中止。先对齐两侧，或只保留一处编辑，再重新运行。
- 定时/手动 CI 不重新解释最后一次提交。如果下载前发现合集与成员已不一致，会停止，给对应 push 任务保留待处理编辑。
- 本地默认使用 HEAD 和工作区差异；多提交场景可显式运行 `SYNC_BASE_SHA=<基准提交> python3 .github/scripts/sync-rules.py`。

### 格式与二进制

| 产物 | 来源 / 处理 |
|---|---|
| `Quantumult/X/Filter/` | Surge 转换；跳过 QX 不支持的类型 |
| `Clash/RuleSet/` | Surge 转换或 Clash 段上游；保留各自 behavior |
| `sing-box/source/` | 转为 sing-box 规则集 JSON |
| `sing-box/rule-set/*.srs` | 官方 sing-box CLI 编译，版本固定 1.12.0 |
| `Clash/RuleSet/*.mrs` | 官方 mihomo CLI 编译 domain/ipcidr，版本固定 v1.19.33；classical 不编译为 MRS |

二进制编译任一失败都会停止发布。对应源码删除后，工作流清理孤立二进制文件。升级编译版本时需同时核对 [sync-rules.yml](../workflows/sync-rules.yml) 与 [lint.yml](../workflows/lint.yml)。

## Surge / Stash 模块同步

`sync-rules.txt` 的 `# >> Module` 段由 `Sync Rules` 每日及变更时同步；转换在 Action 内完成，不依赖在线转换服务。格式映射参考 [Script-Hub](https://github.com/Script-Hub-Org/Script-Hub)，按 [Stash 官方 HTTP 重写](https://stash.wiki/http-engine/rewrite) 和 [脚本配置](https://stash.wiki/script/rewrite-requests)生成原生字段。

| 清单文件名 | 生成到 `Surge/Module/` |
|---|---|
| `BlockAdsBase` | `BlockAdsBase.sgmodule` 和 `Stash/BlockAdsBase.stoverride` |
| `BlockAdsBase.sgmodule` | 仅 `BlockAdsBase.sgmodule` |
| `BlockAdsBase.stoverride` | 仅 `Stash/BlockAdsBase.stoverride` |

Stash 转换模块统一存放在 `Surge/Module/Stash/`；两份面板覆写继续放在 `Pannel/`。

多个来源指向同一个输出文件时按清单顺序合并，不再互相覆盖。`name`、`desc`、`author`、`category` 等元信息取第一个条目，先应用它的行内 `#!key=value` 覆盖；后面的元信息不覆盖、不补齐。规则保持先后顺序并去重，MITM/强制 HTTP 域名合并，重名脚本自动加后缀。参数默认值属于执行配置：保留后续独有参数，同名参数取首个；Stash 使用这些默认值，Surge 继续保留参数占位符。

转换包括域名/IP/端口/逻辑规则、URL/Header/Body 重写（含 jq）、文本/Base64/tiny-gif Map Local、HTTP/cron 脚本、MITM 域名及强制 HTTP 引擎。`requires-body` 和 `binary-body-mode` 转为 Stash 字段，`engine=webview` 对应 Stash 3.6+ 的 `webkit`。Map Local 用原生 `http.mock`，不引入额外脚本。脚本 URL 保持上游来源，转换不保证脚本内部所有 Surge 专用 API 都能在 Stash 运行。

无法映射的配置会写入生成文件的 `# Not converted:` 注释并在 Action 中提示，不会伪造支持；Surge 的 `pre-matching`/`extended-matching` 不带入 Stash，这类规则参数省略提示只记录在 Action 日志，不写入覆写文件。未知参数、无效格式或来源下载失败会中止模块批次，保留上次产物。`http` 排在规则前，内部 MITM 排在重写与脚本前，依据 [Stash 官方示例](https://stash.wiki/configuration/example-config)。未列出的手工模块不参与清理。

## 模块聚合

[sync-modules.py](sync-modules.py) 将 `sync-modules.txt` 中的 sgmodule 合并到 `Surge/Module/BlockAds.sgmodule`，按 section 收集、按名称排序，合并 MITM hostname 并生成参数开关。条目可用 `URL,别名` 为对应应用生成域名开关。

元数据可在现有 BlockAds 文件中维护；来源内容在清单中调整。聚合模块需搭配 BlockAdsBase，详见 [Surge 说明](../../Surge/README.md)。

[sync-modules-beta.py](sync-modules-beta.py) 读取同一清单中的 `;Loon 名称`，仅在 Action 运行时按统一模板展开来源链接。带注释停用的条目不参与转换；无对应 Loon 名称的条目沿用 Surge 来源。仓库清单和生成模块不保存展开后的 Loon 插件链接。

Beta 使用固定提交及 SHA-256 校验的官方 [Script-Hub Beta](https://github.com/Script-Hub-Org/Script-Hub/blob/761f7864785d032cd1d1d616e5a298a0c07aae7d/Rewrite-Parser.beta.js)，参考 QingRex 的预转换方式，将 Loon 3.5.1 配置转为 Surge 后复用正式版聚合器。远程 `jq_file` 在运行时读取并内联；脚本内容和脚本 URL 沿用上游。输出 `Surge/Module/BlockAdsBeta.sgmodule`，头部参数、默认值和说明原样沿用正式版，仅模块标题追加 ` Beta`，模块日期按内容变化更新。Beta 忽略上游日期字段，App 分组不显示日期，避免上游只刷新日期时产生空更新。App 分组、排序、域名参数开关和 MITM 合并格式与正式版相同；脚本标签与正式版一样保留上游原名。

任何来源读取、解析器校验或等价转换失败都会保留已发布产物。QUIC 逻辑规则会完整保留，官方转换器无法添加的可选 `pre-matching` 标志仅记录提示。`Sync Modules` 在同一次校验及提交中更新正式版和 Beta。

## 私人 Mihomo Gist

[Sync Mihomo Gist](../workflows/sync-mihomo-gist.yml) 在 `Sync Config` 成功后，将 `Clash/Mihomo.yaml` 与 `sync-config/Enhanced/myscript.overlay.json` 合并，更新目标私密 Gist 的 `mihomo.yaml`。也可手动运行；只改生成器或工作流时会直接触发。公共基座和现有 JS/Stash 产物的生成方式不变。

在仓库的 Actions Secrets 中配置 `MIHOMO_GIST_ID`（仅 ID）及 `GIST_TOKEN`（具有 `gist` 权限的 classic PAT）。不要将这些值填进工作流或公开日志。发布器只接受私密 Gist，不修改其他文件或可见性；地址、令牌和配置正文不写入日志，完整私人配置仅在发布进程内存中合并，不提交仓库，也不上传构建产物。

Gist 中 `mihomo.yaml` 的顶层 `proxies` 和 `proxy-providers` 均由你手动维护，初始可为 `proxies: []`、`proxy-providers: {}`。每次同步原样保留这两个块，按现有筛选规则把节点加入对应分组；无须另建或引用 `snell.yaml`。主动清空或删除 `proxy-providers` 后不会重新填入基座默认订阅。编辑节点后手动运行此 Action 即可刷新分组候选。手动块无效或 `proxies` 缺失时停止发布，避免用默认值覆盖手写内容。其余配置随基座和 overlay 更新，其中 `disabled_by_default` 在静态 YAML 中会实际移除对应分组和规则。

`extra_pool_groups` 的 `insert_after` 控制分组位置，`tag` 控制该组前的分节注释。例如 Relay 首项使用 `"insert_after": "🇺🇳 Server", "tag": "Relay"`，派生 YAML/Stash 写入 `# Relay`，JS 写入 `// Relay`。修改或删除 `tag` 后注释跟随更新；它不作为代理组配置字段输出。

同一私密 Gist 的 `stash.yaml` 从 `Clash/Script/MyStash.stoverride` 生成，节点只读取最终 `mihomo.yaml`：顶层节点和内联 Provider 的 `payload` 按原顺序合并到 Stash 顶层 `proxies`，每个节点一行，参数保持原值。Stash 文件移除覆写展示元数据及合并标记，其余设置、策略、规则沿用 MyStash；不向仓库或构建产物写入私人节点。

只需维护 Gist 的 `mihomo.yaml` 节点。`Sync Mihomo Gist` 每天北京时间 12:00 检查一次（cron 为 UTC `0 4 * * *`），配置生成成功后及手动运行时也会同步两份文件；Gist 编辑本身不会触发仓库事件，定时执行时间可能受 GitHub 调度影响。内容相同不重复写入。两个生成文件在同一个 PATCH 中更新，其余 Gist 文件保持原样。

当前节点复用支持顶层节点、内联 Provider，以及具有 URL 的 HTTP Provider（`header` 转为 Stash `headers`，延迟测试由 MyStash 策略组管理）。无法跨设备读取本地 file Provider；尚未支持的 Provider 筛选或覆盖选项会停止发布，避免静默漏掉节点。Stash 的 `stash.yaml` 是派生产物，请在 `mihomo.yaml` 维护节点。

[Migrate Mihomo Inline Provider](../workflows/migrate-mihomo-inline.yml) 是显式的一次性迁移：将手写 `proxies` 节点完整移入 `proxy-providers.Manual.payload`，保留节点参数和顺序，顶层变为 `proxies: []`，继续使用 `include-all-providers`。工作流首次添加或手动运行时执行，与普通同步共用并发锁；普通同步不执行迁移。已有 `Manual` 且仍有顶层节点时停止以防覆盖；顶层已为空时重复执行不再移动。迁移后两个区域仍由你维护，私人数据仅在 Action 进程内存中处理。

该迁移工作流同时显式整理 `Manual.payload`：每个节点使用一行 `- {name: ..., type: ...}`，参数和顺序保持一致。常规同步不重新排版，继续原样保留你的手动格式。

## 下载、验证与发布

[_common.py](_common.py) 在一批来源全部成功后才返回给生成器。网络错误、408、429、5xx 最多尝试三次；真实 404 不重试且保留状态码；空响应和无效内容不作为正常产物发布。超时不再写成 `upstream 404`。

| 工作流 | 主要触发条件 | 发布前处理 |
|---|---|---|
| Lint Scripts | 配置、维护脚本、面板、清单与相关工作流变动；PR；手动 | 重生配置、共享验证、sing-box check |
| Sync Config | 主配置、平台基座、overlay 与生成器变动；手动 | 生成配置并验证 |
| Sync Rules | Surge 规则、来源清单与同步器变动；每天 UTC 16:00；手动 | 同步、编译 SRS/MRS、验证 |
| Sync Modules | BlockAds 元数据、来源清单与聚合器变动；每天 UTC 16:00；手动 | 聚合并验证 |

共享验证入口、依赖及测试变动也会触发同步工作流。完整路径过滤以 [workflows/](../workflows/) 为准；面板修改不再无关地触发全部模块下载。

三个同步任务和既有手动历史工作流共用 `push-master`，启用 `queue: max`。同步提交只允许快进推送；运行期间出现外部提交时保留远端，任务失败后可重新运行。自动生成提交不依赖再次触发 push CI，因此每个发布任务都在提交前运行 [validate.py](validate.py)。

修改转换或检测逻辑时，在 [tests/](../tests/) 增加对应行为的回归样例，再执行验证。模拟测试覆盖边界行为；实际客户端兼容性、节点可用性和第三方接口变化仍需结合运行结果判断。
