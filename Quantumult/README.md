# Quantumult X

提供 Quantumult X 示例配置、分流规则和图标资源。

## 使用配置

导入 [Sample.conf 的 Raw 地址](https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/Sample.conf)，将 `[server_remote]` 中的示例订阅地址替换为自己的订阅，再检查策略组是否匹配节点名称。

配置按港、台、新、日、美等地区分组筛选节点。空分组通常需要检查订阅是否已下载，以及节点名是否包含对应的地区标记。DNS、远程规则和重写可按个人需要调整；修改后请保存自己的配置副本，以免重新下载时丢失。

需要 MITM 功能时，请使用自己的证书，并按 Quantumult X 的提示完成安装与信任。

## 单独使用分流规则

[X/Filter/](X/Filter/) 提供 Quantumult X 格式的 `.list` 规则。打开所需文件，复制 Raw 地址，在 `[filter_remote]` 中引用；用 `force-policy` 指定当前配置中已有的策略。

例如将 AI 服务流量交给名为 `Proxy` 的策略：

```ini
[filter_remote]
https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/X/Filter/GenAI.list, tag=GenAI, force-policy=Proxy, enabled=true
```

各平台支持的规则类型不同，请使用本目录的 QX 格式文件，避免直接导入 Surge 或 mihomo 的规则集。

## 图标

[X/Images/](X/Images/) 包含彩色图标、旗帜等资源。打开图片后复制 Raw 地址，即可填入客户端支持的图标字段；这些资源也可用于 Surge、mihomo 和 Stash。
