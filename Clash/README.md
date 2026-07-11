# Clash

本目录下除 `General.yaml` 外均为自动生成产物，**直接编辑会在下次同步时被覆盖**。

| 文件 / 目录 | 说明 |
|---|---|
| `Sample.yaml` | 由 `sync-config.py` 从 `Surge/Profile.conf` 自动生成的完整示例配置（`proxy-providers` 订阅版） |
| `Mihomo.yaml` | `Sample.yaml` 的锚点 / flow 紧凑改写版，功能等价，同样自动生成 |
| `General.yaml` | 通用基础设置参考（手动维护，带逐项中文注释） |
| `RuleSet/` | 由 `sync-rules.py` 从 `Surge/RULE-SET/` 自动转换的规则集 |
| `Script/` | mihomo 覆写脚本（Enhance Script），供 Clash Verge / Mihomo Party 等客户端使用 |

## Script/

- **`Script.js`** — 通用版，由 `sync-config.py` 解析 `Mihomo.yaml` 自动生成：对任意订阅
  （内联节点、`proxy-providers` 或两者混合均兼容）动态生成与 `Surge/Profile.conf`
  等效的策略组 / 规则 / 基础设置。
- **`MyScript.js` / `MyClashBox.js` / `MyScriptColor.js`** — **个人使用**的定制版：
  在 Script.js 同一套自动生成基座上叠加
  [`.github/scripts/sync-config/Enhanced/`](../.github/scripts/sync-config/Enhanced/)
  下同名 `*.overlay.json` 声明的私人差异（改名、图标、地区 fallback、Relay 链等），
  且要求订阅含真实内联节点，不建议他人直接使用——请用 `Script.js`。

修改配置内容请改 `Surge/Profile.conf`（单一来源）；调整 My* 私人差异请改对应的
`*.overlay.json`。生成机制详见 [`.github/scripts/README.md`](../.github/scripts/README.md)。

