# subconverter 订阅转换配置

本目录提供 subconverter 远程配置（`external-config`），用于生成节点分组与分流规则。配置沿用旧版方案，首次使用可优先选择[当前客户端配置](../README.md)。

## 配置选择

| 文件 | 台湾分组与节点旗帜显示 |
|---|---|
| [config1.ini](config1.ini) | 🇨🇳 Taiwan |
| [config2.ini](config2.ini) | 🇹🇼 Taiwan |

两份配置另有少量节点名称匹配差异。

## 使用方式

在 subconverter 服务或前端填写节点订阅、选择目标客户端，将下列任一地址填入「远程配置」或「外部配置」字段：

```text
https://raw.githubusercontent.com/HotKids/Rules/master/subconverter/config1.ini
```

```text
https://raw.githubusercontent.com/HotKids/Rules/master/subconverter/config2.ini
```

直接调用接口时，通过 `config` 参数传入地址，并按服务要求进行 URL 编码。导入转换结果后，检查地区分组并选择服务策略。

转换将替换原订阅规则，为节点添加旗帜并调整部分名称；地区筛选依赖节点命名。本目录不提供节点或转换服务。

部分规则与基座仍引用历史地址。转换失败或分组异常时，应检查远程地址和节点名称，或改用[当前配置](../README.md)。
