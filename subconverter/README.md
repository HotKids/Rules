# subconverter 订阅转换配置

将自己的节点订阅转换为带分组和分流规则的配置时，可把本目录文件作为 subconverter 的远程配置（`external-config`）。这里提供旧版分组方案；新用户可先从[仓库首页](../README.md)选择对应客户端的配置。

## 选择配置

| 文件 | 台湾分组与节点旗帜显示 |
|---|---|
| [config1.ini](config1.ini) | 🇨🇳 Taiwan |
| [config2.ini](config2.ini) | 🇹🇼 Taiwan |

两份文件还存在少量节点名称匹配关键字差异。

## 使用方法

在自己使用的 subconverter 服务或转换前端中填写原始订阅、选择目标客户端，再将以下一个地址填入「远程配置」或「外部配置」字段：

```text
https://raw.githubusercontent.com/HotKids/Rules/master/subconverter/config1.ini
```

```text
https://raw.githubusercontent.com/HotKids/Rules/master/subconverter/config2.ini
```

直接调用 subconverter 时，使用 `config` 参数传入对应地址，并按转换服务要求进行 URL 编码。转换后导入客户端，检查节点是否进入预期地区分组，再选择各服务使用的策略。

这两份文件会生成分流规则并替换原订阅中的规则，也会为节点添加旗帜、调整部分名称。它们不提供节点或订阅转换服务；地区分组依赖节点名称中的关键字。

本目录保留的策略和规则与仓库当前主配置不同，部分规则、基座仍引用历史地址。若转换失败或分组不符合预期，请先检查远程文件能否获取及节点命名是否匹配，或改用[当前配置入口](../README.md)。
