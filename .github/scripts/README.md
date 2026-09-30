# 同步与维护

本目录将配置、规则和模块生成到各客户端目录。生成提交前执行统一验证；上游下载不完整时停止发布，保留 GitHub 上的上一份完整产物。

## 维护入口

| 需要调整的内容 | 源文件 |
|---|---|
| 通用策略组、路由及 Surge 设置 | [Surge/Profile.conf](../../Surge/Profile.conf) |
| 平台输出路径、排除项、URL 映射、重命名 | [sync-config.txt](sync-config.txt) |
| 各平台静态基座 | [sync-config/](sync-config/) 的 ini 文件；Clash 还读取 [General.yaml](../../Clash/General.yaml) |
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
| [clash.py](config_sync/clash.py) | Clash/Mihomo YAML、增强 JS 和结构化 overlay |
| [stash.py](config_sync/stash.py) | Stash 转译及保留注释的 overlay |
| [loon.py](config_sync/loon.py)、[qx.py](config_sync/qx.py)、[surfboard.py](config_sync/surfboard.py)、[singbox.py](config_sync/singbox.py) | 各平台输出 |
| [pipeline.py](config_sync/pipeline.py) | 按依赖顺序组织生成 |

产物包括 `Clash/Sample.yaml`、`Mihomo.yaml`、`Clash/Script/` 的 JS/Stash 覆写、`Surge/Balloon.lcf`、`Surge/Surfboard.conf`、`Quantumult/Sample.conf` 和 `sing-box/config.json`。没有实质变化时保留原时间戳，避免空提交。

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

Stash DNS 在 [stash.py](config_sync/stash.py) 按 [Stash 内置 DNS 文档](https://stash.wiki/features/dns-server)适配，保留 Clash/Mihomo 源中的主 DNS、引导 DNS、私网/NTP/国内域名策略、节点域名 DNS 和 `fake-ip-filter`，不另选主 DNS。源中的 `respect-rules: true` 或普通解析器的 `#RULES` 转为 Stash 的 `follow-rule: true`；没有规则路由要求时保持 `false`。当前源使用 Cloudflare `https://1.1.1.1/dns-query#RULES`，Stash 输出同一 DoH 地址并开启 `follow-rule`，让 DNS 请求按现有规则出站。腾讯/阿里 DoH 仍用于国内域名和独立的 `proxy-server-nameserver`；后者不会跟随代理规则，避免节点域名解析递归。

Stash 官方 DNS 文档定义了 `#h3=true`，未提供 Mihomo 的 `#RULES` / `#策略名` 服务器后缀语法，转换时移除策略后缀、保留 HTTP/3 选项。`#RULES` 的功能由全局 `follow-rule` 适配，指定策略名的逐服务器路由不能等价保留；源配置混用跟随规则与直接出站的解析器时，也不能仅凭这个全局开关保证逐服务器等价。逗号拼接的 policy 键拆成独立域名；Stash 的 policy 按精确域名、通配域名、geosite 的优先级匹配，同级 geosite 使用配置顺序。Mihomo 的 `direct-nameserver` / `direct-nameserver-follow-policy` 没有 Stash 官方文档中的等价配置，因此不输出；对境外域名手动选择 DIRECT 时，两者可能使用不同解析器。监听、模式、缓存、IPv6 与 Fake IP 地址池等客户端管理项也不搬入 Stash 覆写。

Stash 基座转换保留其余注释与排版：境外 QUIC 改为 `PROTOCOL,QUIC` / `no-track`，Provider 健康检查交给策略组的 `interval: 600` / `lazy: true`，并过滤 mihomo 专属字段。节点从基础配置继承，主要设置块使用 `#!replace`。

## 规则同步

[sync-rules.py](sync-rules.py) 依次拉取外部规则与镜像模块、处理 Streaming 双向同步、转换 QX/Clash/sing-box 格式、清理不再需要的产物。

### 上游清单

`sync-rules.txt` 支持 Surge、Clash、Module 段：

```text
URL,名称
DOMAIN-SET,URL,名称
URL,名称 #!remove=a.example,b.example
```

`DOMAIN-SET` 声明裸域名 / 域名后缀来源；转换后使用各平台相应语义。`#!remove` 从镜像中剔除指定域名，同名多来源合并去重。Module 段可覆盖 `#!name`、`#!desc`、`#!author`、`#!category`。

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
| `Clash/RuleSet/*.mrs` | 官方 mihomo CLI 编译 domain/ipcidr，版本固定 v1.19.30；classical 不编译为 MRS |

二进制编译任一失败都会停止发布。对应源码删除后，工作流清理孤立二进制文件。升级编译版本时需同时核对 [sync-rules.yml](../workflows/sync-rules.yml) 与 [lint.yml](../workflows/lint.yml)。

## 模块聚合

[sync-modules.py](sync-modules.py) 将 `sync-modules.txt` 中的 sgmodule 合并到 `Surge/Module/BlockAds.sgmodule`，按 section 收集、按名称排序，合并 MITM hostname 并生成参数开关。条目可用 `URL,别名` 为对应应用生成域名开关。

元数据可在现有 BlockAds 文件中维护；来源内容在清单中调整。聚合模块需搭配 BlockAdsBase，详见 [Surge 说明](../../Surge/README.md)。

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
