# subconverter 旧转换配置

本目录保留原有的订阅转换 `external-config`，目前仅维护 emoji 映射，不跟随主配置生成器同步策略和规则。新配置可从 [仓库首页](../README.md#使用入口) 选择对应客户端入口。

| 文件 | 台湾分组显示 |
|---|---|
| [config1.ini](config1.ini) | 🇨🇳 Taiwan |
| [config2.ini](config2.ini) | 🇹🇼 Taiwan |

两份文件还有少量节点匹配关键字差异，按现有使用需求选择。旗帜用于显示偏好，不表明政治立场。

如需继续使用，在自己的 subconverter 转换请求中将对应文件的 Raw 地址作为远程配置。该目录仍引用部分历史上游地址，使用前需核对其可用性与分组是否符合当前订阅；它不参与 `.github/scripts/` 的自动配置生成。
