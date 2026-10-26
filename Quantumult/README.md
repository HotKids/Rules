# Quantumult X

提供 Quantumult X 示例配置、分流规则和图标资源。

## 使用配置

导入 [Sample.conf](https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/Sample.conf)，替换 `[server_remote]` 中的示例订阅，并核对策略组筛选与节点名称。

地区组按港、台、新、日、美等名称标记筛选。分组为空时，须检查订阅下载状态及节点命名。DNS、规则与重写可按需调整；定制配置应另存副本，避免远程更新覆盖。

启用 MITM 前，须安装并信任自有证书。

## 单独使用分流规则

复制 [X/Filter/](X/Filter/) 中所需 `.list` 文件的 Raw 地址，在 `[filter_remote]` 中引用；`force-policy` 须指定已有策略。

以下示例将 AI 服务流量分配至 `Proxy`：

```ini
[filter_remote]
https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/X/Filter/GenAI.list, tag=GenAI, force-policy=Proxy, enabled=true
```

须使用本目录的 QX 格式，避免直接导入其他平台规则。

## 图标

[X/Images/](X/Images/) 提供彩色图标及旗帜。复制图片 Raw 地址，填入客户端图标字段；亦可用于 Surge、mihomo 与 Stash。
