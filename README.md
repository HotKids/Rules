# HotKids / Rules

代理客户端配置、分流规则、去广告模块、检测面板及图标。节点与订阅需自行配置。

> **本仓库大部分内容依据各工具文档及部分上游仓库，通过 Claude Code / Codex 编写的自动化脚本生成与维护。实际可用性及客户端兼容性未经全面验证，请自行核实后使用。**

## 使用入口

| 客户端 | 配置入口 | 使用说明 |
|---|---|---|
| Surge | [Sample.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Sample.conf) | [配置、模块与面板](Surge/README.md) |
| Mihomo | [Mihomo.yaml](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Mihomo.yaml) | [配置与覆写](Clash/README.md) |
| Stash | [Stash.stoverride](https://raw.githubusercontent.com/HotKids/Rules/master/Clash/Script/Stash.stoverride) | [叠加到已有节点配置](Clash/README.md) |
| Quantumult X | [Sample.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/Sample.conf) | [配置、规则与图标](Quantumult/README.md) |
| Loon | [Balloon.lcf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Balloon.lcf) | [配置使用说明](Surge/README.md) |
| Surfboard | [Surfboard.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Surge/Surfboard.conf) | [配置使用说明](Surge/README.md) |
| sing-box | [config.json](https://raw.githubusercontent.com/HotKids/Rules/master/sing-box/config.json) | [配置模板与规则集](sing-box/README.md) |

## 使用说明

1. 根据客户端选择完整配置、覆写或规则集，并使用 **Raw 地址**导入。
2. 完整配置需填写节点或订阅；覆写需绑定有效节点配置。`My*` 文件包含个人定制，使用前须核对策略组及筛选条件。
3. 本地修改请保存至独立副本，避免远程更新覆盖。

## 按需添加

- **去广告与检测面板**：[Surge / Stash 模块说明](Surge/README.md)。MITM 模块需安装并信任证书，参数及其他要求以模块说明为准。
- **分流规则**：[Surge](Surge/RULE-SET/)、[Mihomo / Stash](Clash/RuleSet/)、[Quantumult X](Quantumult/X/Filter/)、[sing-box](sing-box/README.md)。请选用客户端支持的格式并指定策略。
- **图标**：[图标目录与地址写法](Quantumult/README.md)。

## 更新与自定义

规则及去广告合集自动同步上游，客户端按刷新设置获取更新。部分模块需清除 App 缓存或重新安装后生效，应用更新亦可能影响效果。

自建仓库及私人 Gist 发布见 [自定义与自动更新](.github/scripts/README.md)。其他工具：[subconverter 配置](subconverter/README.md)、[Snell / SS2022 节点管理](snell-panel/README.md)。

规则、脚本及图标来源见文件注释，使用条件以原项目说明为准。
