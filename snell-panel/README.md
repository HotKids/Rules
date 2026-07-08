<div align="center">
  <img src="apps/web/public/favicon.svg" width="76" alt="Snell Panel" />
  <h1>Snell Panel</h1>
  <p>
    <strong>Snell / SS2022 节点管理面板</strong><br />
    Cloudflare Workers + D1 + Hono 后端，同 Worker 托管 Vite / React / HeroUI 前端。
  </p>
  <p>
    <a href="#中文">中文</a> · <a href="#english">English</a>
  </p>
</div>

---

<a id="中文"></a>

<details open>
<summary><strong>🇨🇳 中文版本</strong></summary>

## 项目简介

`snell-panel` 是 `HotKids/Rules` 仓库中的独立面板项目，路径为 `Rules/snell-panel`。它基于 [missuo/snell-panel](https://github.com/missuo/snell-panel) 的思路重写，但源码直接维护在本仓库内，并不是 Git submodule。

面板用于集中管理 **Snell V5 / V6** 与 **Shadowsocks 2022 (SS2022)** 节点：先在面板中创建待安装节点，再复制一行安装命令到服务器执行。服务器完成安装后会自动回填 `ip / port / psk`，节点状态变为可订阅。

SS2022 安装逻辑参考 [jinqians/ss-2022.sh](https://github.com/jinqians/ss-2022.sh) 的核心服务与配置方式：使用 `shadowsocks-rust` / `ss-rust`、`/etc/ss-rust/config.json`、`tcp_and_udp`、TCP Fast Open，以及按 method 生成的 base64 key。

> 详细架构设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 主要功能

- **Snell V5 / V6 与 SS2022**：统一的面板创建、安装、注册流程。
- **SS2022 method 选择**：支持 `2022-blake3-aes-128-gcm`、`2022-blake3-aes-256-gcm`、`2022-blake3-chacha20-poly1305`、`2022-blake3-chacha8-poly1305`。
- **三层凭据模型**：面板 `ACCESS_TOKEN`、后端 `API_TOKEN`、按节点生成的一次性安装 token 相互独立。
- **Relay / 中转节点**：基于已有 active 节点克隆不同入口 IP / port。
- **启用 / 禁用节点**：禁用后节点仍保留在面板中，但不会出现在订阅中。
- **多格式订阅**：支持 Surge、Shadowrocket、Mihomo，并支持订阅 token 轮换、flag、filter、via / relay 选项。
- **Snell V4 / V5 → V6 原地升级**：校验 PSK，迁移配置，移除 V6 不再支持的配置项，并重新上报。
- **响应式 Web 面板**：桌面表格、移动端卡片，支持亮色 / 暗色主题。

## 技术栈与目录结构

| 层级 | 技术 |
|---|---|
| 后端 | Hono on Cloudflare Workers、Cloudflare D1、Drizzle |
| 前端 | Vite、React、HeroUI v3、Tailwind v4 |
| 工具链 | Bun workspace、Wrangler、TypeScript |

```text
apps/server      Hono Worker：API、D1 schema / migrations、SPA 静态资源托管
apps/web         Vite + React + HeroUI v3 前端，构建产物输出到 apps/web/dist
packages/shared  前后端共享 TypeScript 类型与 zod schema
scripts          panel-install.sh 安装脚本、import-legacy.ts 迁移脚本
docs             架构与设计文档
```

所有命令默认从面板根目录执行：

```bash
cd Rules/snell-panel
```

## 部署到 Cloudflare Workers

该项目没有一键部署按钮，因为部署前必须手动创建 D1 数据库并设置 secrets。

```bash
git clone https://github.com/HotKids/Rules
cd Rules/snell-panel
bun install

bunx wrangler login

# D1 与 secrets 在 apps/server 目录执行，因为 wrangler.jsonc 位于此处
cd apps/server

# 创建 D1，并将输出的 database_id 填入 wrangler.jsonc
bunx wrangler d1 create snell-panel
bunx wrangler d1 migrations apply snell-panel --remote

# 设置两个互相独立的 secret
printf '%s' "<access-token>" | bunx wrangler secret put ACCESS_TOKEN
printf '%s' "<api-token>"    | bunx wrangler secret put API_TOKEN

# 回到面板根目录构建前端并部署 Worker
cd ../..
bun run build
bunx wrangler deploy
```

推荐用下面的命令生成强随机 token：

```bash
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; echo
```

部署完成后，打开 Worker URL，并使用 `ACCESS_TOKEN` 登录。

## 本地开发

```bash
bun install

# 终端 1：Worker + 本地 D1
cd apps/server
cp .dev.vars.example .dev.vars          # 填入 ACCESS_TOKEN / API_TOKEN
bun run db:migrate:local
bun run dev                             # http://localhost:8787

# 终端 2：前端开发服务器，/api 会代理到 Worker
cd apps/web
bun run dev                             # http://localhost:5173
```

## 配置项

| 名称 | 类型 | 用途 |
|---|---|---|
| `ACCESS_TOKEN` | secret | 面板登录与管理端 API 鉴权 |
| `API_TOKEN` | secret | 后端数据面写入 token，不应暴露给前端或 VPS |
| `SNELL_V5_VERSION` | var | Snell V5 精确版本，默认 `v5.0.1` |
| `SNELL_V6_VERSION` | var | Snell V6 精确版本，默认 `v6.0.0b4` |

订阅链接使用的 token 独立存储在 D1 中，可在面板的 Subscription 弹窗中重置，不等同于 `ACCESS_TOKEN`。

## 节点生命周期

1. **Add Node**：选择协议、版本或 method，填写名称，可选预填 IP / Port，创建 `pending` 节点。
2. **Provision**：复制面板生成的一行命令到服务器执行。脚本安装 Snell 或 `ss-rust`，写入 systemd，启用 TFO，尝试开放端口，并回填 `ip / port / psk`。
3. **Active**：注册成功后节点变为 `active`，可出现在订阅中。
4. **Relay**：对 active 节点创建新的入口地址，用于中转 / 落地分离。
5. **Upgrade**：对 Snell V4 / V5 节点执行 V6 原地升级。
6. **Disable / Delete**：隐藏节点或删除节点。安装脚本的 uninstall 会按 `node_id` 删除面板记录。

安装脚本会在服务器记录节点元数据：

- Snell：`/etc/snell/.install_meta`
- SS2022：`/etc/ss-rust/.install_meta`

## 从旧版面板导入

```bash
bun scripts/import-legacy.ts "https://old-panel/entries?token=..." > import.sql
bunx wrangler d1 execute snell-panel --remote --file=import.sql -c apps/server/wrangler.jsonc
```

导入脚本会保留原 `node_id`，重新分配自增整数 id，并保留可迁移的数据字段。

## 常用命令

```bash
bun run typecheck        # 全 workspace 类型检查
bun run build            # 构建 Web 前端
bun run deploy           # 构建并部署 Worker
bun run db:generate      # 生成 Drizzle migration
bun run db:migrate:local # 应用本地 D1 migration
```

## License

See [`LICENSE`](LICENSE).

</details>

---

<a id="english"></a>

<details>
<summary><strong>🇺🇸 English Version</strong></summary>

## Overview

`snell-panel` is a standalone panel project under `Rules/snell-panel` in the `HotKids/Rules` repository. It is rewritten from the ideas behind [missuo/snell-panel](https://github.com/missuo/snell-panel), but the source code is maintained directly in this repository rather than as a Git submodule.

The panel manages **Snell V5 / V6** and **Shadowsocks 2022 (SS2022)** nodes. You create a pending node in the panel, copy the generated one-line install command to a server, and the server registers back with `ip / port / psk` once installation succeeds.

The SS2022 provisioner follows the core service and configuration approach from [jinqians/ss-2022.sh](https://github.com/jinqians/ss-2022.sh): `shadowsocks-rust` / `ss-rust`, `/etc/ss-rust/config.json`, `tcp_and_udp`, TCP Fast Open, and method-aware base64 keys.

> See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture record.

## Features

- **Snell V5 / V6 and SS2022** with one panel-first provisioning flow.
- **Selectable SS2022 methods**: `2022-blake3-aes-128-gcm`, `2022-blake3-aes-256-gcm`, `2022-blake3-chacha20-poly1305`, and `2022-blake3-chacha8-poly1305`.
- **Three credential layers**: panel `ACCESS_TOKEN`, backend `API_TOKEN`, and per-node one-time install tokens.
- **Relay / transit nodes**: clone an active node behind a different entry IP / port.
- **Enable / disable nodes**: keep a node in the panel while hiding it from subscriptions.
- **Subscription formats**: Surge, Shadowrocket, and Mihomo, with rotatable subscription token, flag, filter, and via / relay options.
- **In-place Snell V4 / V5 → V6 upgrade**: validates PSK, migrates config, removes unsupported V6 keys, and reports back.
- **Responsive web panel**: desktop table, mobile cards, and light / dark themes.

## Stack and Layout

| Layer | Technology |
|---|---|
| Backend | Hono on Cloudflare Workers, Cloudflare D1, Drizzle |
| Frontend | Vite, React, HeroUI v3, Tailwind v4 |
| Tooling | Bun workspace, Wrangler, TypeScript |

```text
apps/server      Hono Worker: API, D1 schema / migrations, and SPA asset serving
apps/web         Vite + React + HeroUI v3 frontend, built into apps/web/dist
packages/shared  Shared TypeScript types and zod schemas
scripts          panel-install.sh provisioner and import-legacy.ts migration helper
docs             Architecture and design docs
```

Run commands from the panel root unless noted otherwise:

```bash
cd Rules/snell-panel
```

## Deploy to Cloudflare Workers

There is no one-click deploy button because you must create a D1 database and configure secrets before deployment.

```bash
git clone https://github.com/HotKids/Rules
cd Rules/snell-panel
bun install

bunx wrangler login

# D1 and secrets are configured from apps/server because wrangler.jsonc lives there
cd apps/server

# Create D1, then paste the printed database_id into wrangler.jsonc
bunx wrangler d1 create snell-panel
bunx wrangler d1 migrations apply snell-panel --remote

# Set two independent secrets
printf '%s' "<access-token>" | bunx wrangler secret put ACCESS_TOKEN
printf '%s' "<api-token>"    | bunx wrangler secret put API_TOKEN

# Return to the panel root, build the SPA, and deploy the Worker
cd ../..
bun run build
bunx wrangler deploy
```

Generate strong random tokens with:

```bash
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; echo
```

After deployment, open the Worker URL and sign in with `ACCESS_TOKEN`.

## Local Development

```bash
bun install

# Terminal 1: Worker + local D1
cd apps/server
cp .dev.vars.example .dev.vars          # fill ACCESS_TOKEN / API_TOKEN
bun run db:migrate:local
bun run dev                             # http://localhost:8787

# Terminal 2: frontend dev server; /api proxies to the Worker
cd apps/web
bun run dev                             # http://localhost:5173
```

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `ACCESS_TOKEN` | secret | Panel login and admin API authentication |
| `API_TOKEN` | secret | Backend data-plane write token; should not be exposed to the frontend or VPS hosts |
| `SNELL_V5_VERSION` | var | Exact Snell V5 build, default `v5.0.1` |
| `SNELL_V6_VERSION` | var | Exact Snell V6 build, default `v6.0.0b4` |

The subscription token is stored separately in D1 and can be reset from the Subscription modal. It is not the same as `ACCESS_TOKEN`.

## Node Lifecycle

1. **Add Node**: choose protocol, version or method, enter a name, and optionally prefill IP / Port to create a `pending` node.
2. **Provision**: copy the generated one-line command to the server. The script installs Snell or `ss-rust`, writes systemd units, enables TFO, tries to open ports, and reports `ip / port / psk` back.
3. **Active**: after successful registration, the node becomes `active` and can appear in subscriptions.
4. **Relay**: create a different entry address for an active node.
5. **Upgrade**: run an in-place upgrade for Snell V4 / V5 nodes to V6.
6. **Disable / Delete**: hide a node from subscriptions or remove it. The provisioner uninstall flow deletes the panel record by `node_id`.

The provisioner stores node metadata on the server:

- Snell: `/etc/snell/.install_meta`
- SS2022: `/etc/ss-rust/.install_meta`

## Import from the Legacy Panel

```bash
bun scripts/import-legacy.ts "https://old-panel/entries?token=..." > import.sql
bunx wrangler d1 execute snell-panel --remote --file=import.sql -c apps/server/wrangler.jsonc
```

The importer preserves the original `node_id`, reassigns auto-increment integer ids, and keeps migratable fields.

## Common Commands

```bash
bun run typecheck        # Type-check the full workspace
bun run build            # Build the web frontend
bun run deploy           # Build and deploy the Worker
bun run db:generate      # Generate a Drizzle migration
bun run db:migrate:local # Apply local D1 migrations
```

## License

See [`LICENSE`](LICENSE).

</details>
