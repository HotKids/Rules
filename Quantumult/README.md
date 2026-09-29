# Quantumult X

本目录包含 Quantumult X 配置、规则，以及供仓库各平台共用的图标。

| 内容 | 用途 | 维护方式 |
|---|---|---|
| [Sample.conf](Sample.conf) | 完整示例配置 | 由 sync-config.py 生成 |
| [X/Filter/](X/Filter/) | QX 格式规则 | 由 sync-rules.py 转换 |
| [X/Images/](X/Images/) | 彩色图标、旗帜及其他图标集合 | 手动维护 |

导入配置使用 [Sample.conf 的 Raw 地址](https://raw.githubusercontent.com/HotKids/Rules/master/Quantumult/Sample.conf)，再按自己的环境调整订阅和节点。图标是独立资源，也可被 Surge、mihomo 和 Stash 的配置引用。

## 修改配置与规则

- 通用分组和规则：[Surge/Profile.conf](../Surge/Profile.conf)。
- QX 基座、DNS、脚本和本地差异：[qx.ini](../.github/scripts/sync-config/qx.ini)。
- 平台排除项、名称和 URL 映射：[sync-config.txt](../.github/scripts/sync-config.txt) 的 Quantumult X 段。
- 规则内容：[Surge/RULE-SET/](../Surge/RULE-SET/)；上游镜像则修改 [sync-rules.txt](../.github/scripts/sync-rules.txt)。

生成器会转换支持的规则类型，并跳过 QX 不适用的类型；QX 产物与 Surge 源文件不保证逐条相同。不要把 `Sample.conf` 或 `X/Filter/` 当作长期维护源，后续同步会覆盖它们。

同步和验证命令见 [维护说明](../.github/scripts/README.md)。
