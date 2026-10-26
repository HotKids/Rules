# HotKids / Rules

代理客户端配置、分流规则、去广告模块、检测面板与图标。按所用客户端选择下方入口；节点与订阅需自行准备。

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

## 开始使用

1. 打开对应客户端的使用说明，选择完整配置、覆写或单独规则集。
2. 完整配置需填写自己的订阅或节点；覆写需绑定到已有节点的配置。名称以 `My` 开头的文件包含个人定制，使用前先检查策略组与筛选条件。
3. 远程导入使用上表链接或文件页面的 **Raw 地址**。需要自行修改完整配置时，先保存副本，避免远程更新覆盖本地编辑。

## 按需添加

- **去广告与检测面板**：见 [Surge / Stash 模块说明](Surge/README.md)。启用需要 MITM 的模块前，须在客户端安装并信任自己的证书；具体要求和参数以模块说明为准。
- **分流规则**：[Surge](Surge/RULE-SET/)、[Mihomo / Stash](Clash/RuleSet/)、[Quantumult X](Quantumult/X/Filter/)、[sing-box](sing-box/README.md)。选择对应客户端支持的格式，并在规则中指定自己的策略。
- **图标**：[图标目录与地址写法](Quantumult/README.md)。

## 更新与自定义

规则和去广告合集会自动同步上游，客户端按各自的刷新设置获取更新。应用更新后，去广告效果也可能变化；首次启用部分模块需要清除 App 缓存或重新安装，详见模块说明。

需要在自己的仓库自动更新配置或发布私人 Gist，见 [自定义与自动更新](.github/scripts/README.md)。另有 [旧版 subconverter 配置](subconverter/README.md) 和 [Snell / SS2022 节点管理工具](snell-panel/README.md)。

上游规则、脚本和图标的来源见各文件注释与目录说明，使用条件以原项目说明为准。
