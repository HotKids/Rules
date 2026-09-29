# HotKids / Rules

自用的代理配置、分流规则、模块、面板脚本与图标库，覆盖 Surge、mihomo、Stash、Quantumult X、Loon、Surfboard 和 sing-box。

## 使用入口

| 客户端 / 用途 | 文件 | 使用方式 |
|---|---|---|
| Surge | [Sample.conf](Surge/Sample.conf) / [Profile.conf](Surge/Profile.conf) | 示例入口与主配置 |
| Clash/mihomo | [Sample.yaml](Clash/Sample.yaml) / [Mihomo.yaml](Clash/Mihomo.yaml) | 两种排版，配置内容等价 |
| Quantumult X | [Sample.conf](Quantumult/Sample.conf) | 完整示例配置 |
| Loon | [Balloon.lcf](Surge/Balloon.lcf) | 完整示例配置 |
| Surfboard | [Surfboard.conf](Surge/Surfboard.conf) | 完整示例配置 |
| sing-box | [config.json](sing-box/config.json) | 含示例节点的配置模板，使用前替换节点 |

远程导入使用文件的 **Raw 地址**，例如：[Stash 配置覆写](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Stash.stoverride)。示例配置中的订阅、节点和个人策略需要按自己的环境调整；名称以 `My` 开头的版本包含个人定制。

## 修改哪里

配置以 [Surge/Profile.conf](Surge/Profile.conf) 为主要来源，同时读取平台基座、映射和 overlay。规则既有手工维护项，也有上游镜像，不能把所有生成文件当作独立源文件编辑。

| 需要调整的内容 | 维护位置 |
|---|---|
| 通用策略组、分流、Surge 设置 | [Surge/Profile.conf](Surge/Profile.conf) |
| 平台基础设置、差异与 URL 映射 | [.github/scripts/sync-config/](.github/scripts/sync-config/) 与 [sync-config.txt](.github/scripts/sync-config.txt)；Clash 通用设置还读取 [General.yaml](Clash/General.yaml) |
| `My*` 私人定制 | [Enhanced/*.overlay.json](.github/scripts/sync-config/Enhanced/) |
| 手工规则与 Streaming 成员 | [Surge/RULE-SET/](Surge/RULE-SET/) |
| 上游规则、镜像模块与过滤项 | [sync-rules.txt](.github/scripts/sync-rules.txt) |
| BlockAds 聚合来源 | [sync-modules.txt](.github/scripts/sync-modules.txt) |
| 面板与检测逻辑 | [Surge/Module/Pannel/](Surge/Module/Pannel/) 与 [Scripts/](Surge/Module/Scripts/) |
| 图标 | [Quantumult/X/Images/](Quantumult/X/Images/) |

其他平台的配置、规则以及 `.srs` / `.mrs` 由脚本生成，直接修改会被后续同步覆盖。维护流程、失败处理和验证命令见 [同步脚本说明](.github/scripts/README.md)。

## 目录说明

- [Surge](Surge/README.md)：主配置、模块、面板与手工规则。
- [Clash / mihomo / Stash](Clash/README.md)：配置、覆写与规则集。
- [Quantumult X](Quantumult/README.md)：配置、规则与共享图标。
- [sing-box](sing-box/README.md)：配置模板与源码/二进制规则集。
- [subconverter](subconverter/README.md)：保留的旧转换配置。
- [snell-panel](snell-panel/README.md)：独立的 Snell / SS2022 节点管理项目。

上游规则和脚本的来源保留在清单及文件注释中；具体使用条件以各来源项目说明为准。
