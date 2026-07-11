# Quantumult

| 文件 / 目录 | 维护方式 | 说明 |
|---|---|---|
| `Sample.conf` | 🤖 自动 | Quantumult X 完整示例配置，由 `sync-config.py` 从 `Surge/Profile.conf` 生成，改动会被下次同步覆盖 |
| `X/Filter/` | 🤖 自动 | QX 格式规则集，由 `sync-rules.py` 从 `Surge/RULE-SET/` 转换（不支持的规则类型自动跳过），改动会被下次同步覆盖 |
| `X/Images/` | ✏️ 手动 | 图标库（`Color/` 彩色策略组图标、`Flags/` 地区旗帜、`Country/`、`Liquid Glass/`、`Marvel/` 等），供本仓库各平台配置的 `icon` / `icon-url` 引用 |

规则内容改动请提交到 `Surge/RULE-SET/`，配置改动请改 `Surge/Profile.conf`。
同步机制详见 [`.github/scripts/README.md`](../.github/scripts/README.md)。
