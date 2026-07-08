#!/usr/bin/env bash
set -euo pipefail

git apply <<'PATCH'
diff --git a/snell/README.md b/snell/README.md
index 6d979da9..a0598e6f 100644
--- a/snell/README.md
+++ b/snell/README.md
@@ -1,57 +1,50 @@
 # Snell Toolkit
 
-`snell/` 是 `HotKids/Rules` 里独立维护的 Snell Toolkit。现在只保留一个入口脚本：
+`snell/` 是 `HotKids/Rules` 里独立维护的 Snell Toolkit。现在以 Panel 为主入口：
 
-- `snell-anytls.sh`：统一管理 Snell、ShadowTLS、AnyTLS、基础流量查看和 Snell Panel。
-- `panel/`：面板源码目录，由 `snell-anytls.sh` 的 Snell Panel 菜单调用和管理。
+- `panel/`：Snell Panel 源码和部署入口，负责节点开通、升级、订阅和日常管理。
+- `panel/scripts/snell-install.sh`：由 Panel 生成命令并通过 `/install.sh` 下发到 VPS 的节点开通器。
+- `snell-anytls.sh`：保留为独立 VPS 备用脚本，不再作为 Panel 工作流入口。
 
 本目录按当前代码独立维护，不再保留外部快照，不再自动同步外部脚本仓库。
 
-## 统一入口脚本
+## 推荐工作流
 
-本地运行：
+部署并登录 Panel：
 
 ```bash
-chmod +x snell/snell-anytls.sh
-sudo bash snell/snell-anytls.sh
+cd snell/panel
+bun install
+# 按 snell/panel/README.md 创建 D1 并设置 ACCESS_TOKEN / API_TOKEN 后：
+bun run deploy
 ```
 
-远程运行：
+随后在 Panel 中添加节点，复制面板生成的一次性命令到 VPS 执行。VPS 上执行的是 Panel 托管的 `/install.sh`，它会完成 Snell 安装、systemd 服务、端口放行尝试、TFO 设置，并把 `ip/port/psk` 注册回 Panel。
 
-```bash
-bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/snell-anytls.sh)
-```
-
-脚本功能：
+Panel 工作流支持：
 
-- Snell v5 / v6 安装、切换、更新、查看、卸载
-- ShadowTLS 安装、更新、查看、卸载
-- AnyTLS 安装、更新、查看、卸载
-- Snell Panel 依赖安装、本地变量写入、本地迁移、开发服务、构建和部署
-- 查看当前节点配置
-- 查看连接和监听端口
+- Snell v5 / v6 节点开通
+- 节点升级到 Snell v6
+- 节点启用、禁用、Relay 和删除
+- Surge / Shadowrocket / Mihomo 订阅
+- 订阅 token 轮换
 
-本脚本不使用 VLESS / REALITY / sing-box / Xray，并已移除 Snell v4，仅保留 Snell v5 / v6。
+Panel 安装器不使用 VLESS / REALITY / sing-box / Xray，并已移除 Snell v4，仅保留 Snell v5 / v6。
 
 ## 面板
 
-面板源码直接放在 `snell/panel/`，作为普通源码目录维护。日常使用直接运行 `snell/snell-anytls.sh`，然后进入 `管理 Snell Panel`。
+面板源码直接放在 `snell/panel/`，作为普通源码目录维护。部署前需要按 `snell/panel/README.md` 创建 D1，并设置 `ACCESS_TOKEN` / `API_TOKEN`。
 
-面板支持：
+## 备用脚本
 
-- Snell v5 / v6 节点管理
-- 一次性安装命令
-- Surge / Shadowrocket / Mihomo 订阅
-- 节点启用、禁用、Relay 和升级
+`snell-anytls.sh` 仍保留给不部署 Panel 的场景使用，可独立安装 Snell、ShadowTLS、AnyTLS 和查看基础流量。Panel 工作流不依赖它。
 
-如果只想管理面板，不需要 root 权限：
+远程运行备用脚本：
 
 ```bash
-bash snell/snell-anytls.sh
+bash <(curl -L -s https://raw.githubusercontent.com/HotKids/Rules/master/snell/snell-anytls.sh)
 ```
 
-面板部署前仍需要按 `snell/panel/README.md` 创建 D1，并设置 `ACCESS_TOKEN` / `API_TOKEN`。
-
 ## AnyTLS 输出示例
 
 AnyTLS URI：
diff --git a/snell/panel/README.md b/snell/panel/README.md
index 8ed7d797..c5ddca2f 100644
--- a/snell/panel/README.md
+++ b/snell/panel/README.md
@@ -1,7 +1,7 @@
 <div align="center">
   <img src="apps/web/public/favicon.svg" width="76" alt="Snell Panel" />
   <h1>Snell Panel</h1>
-  <p>Manage Snell proxy nodes and generate subscription links.<br/>
+  <p>Provision Snell proxy nodes and generate subscription links.<br/>
   Hono on <b>Cloudflare Workers + D1</b>, with a <b>HeroUI v3</b> panel served from the same Worker.</p>
 </div>
 
@@ -21,7 +21,7 @@ cd snell/panel
 
 ## Features
 
-- **V5 / V6 nodes** with an *add-then-install* flow — create a node in the panel, run the generated one-line command on your server, and it back-fills `ip/port/psk`.
+- **V5 / V6 nodes** with a Panel-first provisioning flow — create a node, run the generated one-line command on your server, and it back-fills `ip/port/psk`.
 - **Two independent secrets**: a panel **Access Token** and a backend **API Token**; servers only ever receive a **per-node one-time install token**.
 - **Relay / transit nodes** — clone an active node behind a different IP/port.
 - **Enable / disable** — hide a node from subscriptions while it keeps running.
@@ -42,10 +42,10 @@ See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.
 | Tooling | Bun (workspace, scripts), Wrangler (deploy) |
 
 ```
-apps/server   Hono Worker (API + serves the SPA) + D1 schema/migrations
-apps/web      Vite + React + HeroUI v3 SPA  → builds to apps/web/dist
+apps/server      Hono Worker (API + serves the SPA) + D1 schema/migrations
+apps/web         Vite + React + HeroUI v3 SPA  -> builds to apps/web/dist
 packages/shared  Shared TS types + zod schemas
-scripts       snell-install.sh (installer) + import-legacy.ts
+scripts          snell-install.sh (Panel provisioner) + import-legacy.ts
 ```
 
 ---
@@ -124,13 +124,15 @@ The **subscription token** is separate, stored in D1, and rotatable from the pan
 ## Node lifecycle
 
 1. **Add Node** — pick V5/V6, name, optionally pre-fill IP/Port → a `pending` node.
-2. **Install** — copy the generated one-line command, run it on the server; it installs
-   snell and registers `ip/port/psk` → the node becomes `active`.
+2. **Provision** — copy the generated one-line command, run it on the server; it installs
+   Snell, writes systemd, enables TFO, tries to open the TCP port, and registers
+   `ip/port/psk` → the node becomes `active`.
 3. **Relay** — clone an active node behind a different IP/port (transit front).
 4. **Upgrade** — migrate a V4/V5 node to V6 in place (config migration + binary swap).
 
-The installer (`scripts/snell-install.sh`) stores `node_id` in `/etc/snell/.install_meta`,
-so `uninstall` removes the panel entry **by node id**, not by IP.
+The provisioner (`scripts/snell-install.sh`, served by the Worker at `/install.sh`) stores
+`node_id` in `/etc/snell/.install_meta`, so `uninstall` removes the panel entry **by node id**,
+not by IP.
 
 ---
 
diff --git a/snell/panel/apps/server/src/db/schema.ts b/snell/panel/apps/server/src/db/schema.ts
index 85034544..491176f8 100644
--- a/snell/panel/apps/server/src/db/schema.ts
+++ b/snell/panel/apps/server/src/db/schema.ts
@@ -1,7 +1,7 @@
 import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
 
 /** A Snell node. Created as a draft (status='pending'), then back-filled by the
- *  installer callback (status='active'). */
+ *  provisioner callback (status='active'). */
 export const nodes = sqliteTable(
   "nodes",
   {
@@ -31,7 +31,7 @@ export const nodes = sqliteTable(
   }),
 );
 
-/** Per-node, single-use, expiring tokens embedded in install/upgrade commands. */
+/** Per-node, single-use, expiring tokens embedded in provision/upgrade commands. */
 export const installTokens = sqliteTable(
   "install_tokens",
   {
diff --git a/snell/panel/apps/server/src/index.ts b/snell/panel/apps/server/src/index.ts
index a5871225..c16c6d33 100644
--- a/snell/panel/apps/server/src/index.ts
+++ b/snell/panel/apps/server/src/index.ts
@@ -31,7 +31,7 @@ app.use("/api/*", (c, next) => {
 
 app.get("/api/snell-versions", requireAccess, (c) => c.json(resolveVersions(c.env)));
 
-// Installer callback (token / API_TOKEN auth) must be registered before the
+// Provisioner callback (token / API_TOKEN auth) must be registered before the
 // admin router so its per-route auth applies, not the admin guard.
 app.route("/api/nodes", registerRouter);
 app.route("/api/nodes", nodesRouter);
diff --git a/snell/panel/apps/server/src/lib/command.ts b/snell/panel/apps/server/src/lib/command.ts
index 859f5cf4..ecf52464 100644
--- a/snell/panel/apps/server/src/lib/command.ts
+++ b/snell/panel/apps/server/src/lib/command.ts
@@ -14,24 +14,30 @@ export interface CommandParams {
   purpose: TokenPurpose;
 }
 
-/** Build the copy-paste command shown in the panel's Install / Upgrade modal. */
+function shellArg(value: string): string {
+  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
+  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
+}
+
+/** Build the copy-paste command shown in the panel's Provision / Upgrade modal. */
 export function buildCommand(p: CommandParams): string {
   const { apiUrl, node, token, version, snellVersion, purpose } = p;
   const args: string[] = [
-    `bash <(curl -fsSL ${apiUrl}/install.sh) ${purpose}`,
-    `--api-url ${apiUrl}`,
-    `--node-id ${node.nodeId}`,
-    `--token ${token}`,
-    `--version ${version}`,
-    `--snell-version ${snellVersion}`,
+    `bash <(curl -fsSL ${shellArg(`${apiUrl}/install.sh`)}) ${purpose}`,
+    `--api-url ${shellArg(apiUrl)}`,
+    `--node-id ${shellArg(node.nodeId)}`,
+    `--token ${shellArg(token)}`,
+    `--version ${shellArg(version)}`,
+    `--snell-version ${shellArg(snellVersion)}`,
+    `--name ${shellArg(node.nodeName)}`,
   ];
 
   if (purpose === "install") {
-    // Pre-filled IP/Port must be honored verbatim by the installer.
-    // The node name is panel-authoritative (set at creation, never overwritten
-    // by register), so it is intentionally NOT passed to the installer.
-    if (node.ipPrefilled && node.ip) args.push(`--ip ${node.ip}`);
-    if (node.portPrefilled && node.port) args.push(`--port ${node.port}`);
+    // Pre-filled IP/Port must be honored verbatim by the provisioner.
+    // The panel remains authoritative for the node name; --name is only used
+    // for the VPS-side completion summary.
+    if (node.ipPrefilled && node.ip) args.push(`--ip ${shellArg(node.ip)}`);
+    if (node.portPrefilled && node.port) args.push(`--port ${shellArg(String(node.port))}`);
   }
 
   // One line — easier to paste; no backslash continuations.
diff --git a/snell/panel/apps/server/src/lib/token.ts b/snell/panel/apps/server/src/lib/token.ts
index 43bce2bb..48e7b686 100644
--- a/snell/panel/apps/server/src/lib/token.ts
+++ b/snell/panel/apps/server/src/lib/token.ts
@@ -40,7 +40,7 @@ export async function mintToken(
 }
 
 /**
- * Validate a token for a node WITHOUT consuming it (installer pre-flight, so a
+ * Validate a token for a node WITHOUT consuming it (provisioner pre-flight, so a
  * doomed install never starts). Looks the token up by its hash.
  */
 export async function validateToken(
diff --git a/snell/panel/apps/server/src/middleware/auth.ts b/snell/panel/apps/server/src/middleware/auth.ts
index ee185002..d6243756 100644
--- a/snell/panel/apps/server/src/middleware/auth.ts
+++ b/snell/panel/apps/server/src/middleware/auth.ts
@@ -19,7 +19,7 @@ export function bearerToken(c: Context<AppEnv>): string | null {
 }
 
 /** Token from `Authorization: Bearer <t>` or the `?token=` query param.
- *  Used only where a URL token is required: subscriptions and installer callbacks. */
+ *  Used only where a URL token is required: subscriptions and provisioner callbacks. */
 export function extractToken(c: Context<AppEnv>): string | null {
   return bearerToken(c) ?? c.req.query("token") ?? null;
 }
diff --git a/snell/panel/apps/server/src/routes/install.ts b/snell/panel/apps/server/src/routes/install.ts
index 254e69a1..8571a035 100644
--- a/snell/panel/apps/server/src/routes/install.ts
+++ b/snell/panel/apps/server/src/routes/install.ts
@@ -10,7 +10,7 @@ const script = installScript.replace(/\r\n?/g, "\n");
 
 const router = new Hono<AppEnv>();
 
-// GET /install.sh — serve the installer so the generated command can curl it.
+// GET /install.sh — serve the provisioner so the generated command can curl it.
 router.get("/", (c) => {
   c.header("Content-Type", "text/x-shellscript; charset=utf-8");
   c.header("Cache-Control", "no-cache");
diff --git a/snell/panel/apps/server/src/routes/nodes.ts b/snell/panel/apps/server/src/routes/nodes.ts
index 4d3d15c8..c1499592 100644
--- a/snell/panel/apps/server/src/routes/nodes.ts
+++ b/snell/panel/apps/server/src/routes/nodes.ts
@@ -98,7 +98,7 @@ router.post("/:id/relay", requireAccess, zValidator("json", relayNodeSchema), as
   return c.json({ node: toNodeDTO(inserted[0]) }, 201);
 });
 
-// GET /api/nodes/:id/install — mint a one-time token + build the install command
+// GET /api/nodes/:id/install — mint a one-time token + build the provisioning command
 router.get("/:id/install", requireAccess, async (c) => {
   const db = c.get("db");
   const row = await getNode(db, c.req.param("id"));
@@ -158,7 +158,7 @@ router.patch("/:id", requireAccess, zValidator("json", patchNodeSchema), async (
   return c.json({ node: toNodeDTO(updated!) });
 });
 
-// DELETE /api/nodes/:id — panel (ACCESS) or installer uninstall (API_TOKEN)
+// DELETE /api/nodes/:id — panel (ACCESS) or provisioner uninstall (API_TOKEN)
 router.delete("/:id", requireAccessOrApiToken, async (c) => {
   const db = c.get("db");
   const id = c.req.param("id");
diff --git a/snell/panel/apps/server/src/routes/register.ts b/snell/panel/apps/server/src/routes/register.ts
index ec184e4d..b4a16b7c 100644
--- a/snell/panel/apps/server/src/routes/register.ts
+++ b/snell/panel/apps/server/src/routes/register.ts
@@ -11,7 +11,7 @@ import { toNodeDTO } from "../lib/dto";
 
 const router = new Hono<AppEnv>();
 
-// GET /api/nodes/:id/verify-token — installer pre-flight; does NOT consume the token.
+// GET /api/nodes/:id/verify-token — provisioner pre-flight; does NOT consume the token.
 router.get("/:id/verify-token", async (c) => {
   const db = c.get("db");
   const id = c.req.param("id");
@@ -25,7 +25,7 @@ router.get("/:id/verify-token", async (c) => {
   return c.json({ ok: true });
 });
 
-// POST /api/nodes/:id/register — installer callback (one-time token OR API_TOKEN)
+// POST /api/nodes/:id/register — provisioner callback (one-time token OR API_TOKEN)
 router.post("/:id/register", zValidator("json", registerNodeSchema), async (c) => {
   const db = c.get("db");
   const id = c.req.param("id");
diff --git a/snell/panel/apps/server/wrangler.jsonc b/snell/panel/apps/server/wrangler.jsonc
index 8357ec3d..86639521 100644
--- a/snell/panel/apps/server/wrangler.jsonc
+++ b/snell/panel/apps/server/wrangler.jsonc
@@ -4,7 +4,7 @@
   "main": "src/index.ts",
   "compatibility_date": "2025-09-01",
   // Serve the built SPA as static assets from the same Worker (same origin → no CORS).
-  // `run_worker_first` forces the Worker to handle the API + installer script so the
+  // `run_worker_first` forces the Worker to handle the API + provisioner so the
   // SPA not-found fallback doesn't swallow them.
   "assets": {
     "directory": "../web/dist",
@@ -25,6 +25,6 @@
     "SNELL_V6_VERSION": "v6.0.0b4",
     "ENVIRONMENT": "production"
   },
-  // Bundle the installer script as a text module so GET /install.sh can serve it.
+  // Bundle the provisioner as a text module so GET /install.sh can serve it.
   "rules": [{ "type": "Text", "globs": ["**/*.sh"], "fallthrough": true }]
 }
diff --git a/snell/panel/apps/web/src/components/CommandBlock.tsx b/snell/panel/apps/web/src/components/CommandBlock.tsx
index af31572a..27af6b1a 100644
--- a/snell/panel/apps/web/src/components/CommandBlock.tsx
+++ b/snell/panel/apps/web/src/components/CommandBlock.tsx
@@ -2,9 +2,9 @@ import { useState } from "react";
 
 type Seg = { text: string; cls: string };
 
-const KEYWORDS = new Set(["bash", "curl", "install", "upgrade", "uninstall"]);
+const KEYWORDS = new Set(["bash", "curl", "install", "provision", "setup", "upgrade", "uninstall"]);
 
-// Lightweight highlighter for the installer command. prism-react-renderer does
+// Lightweight highlighter for the provisioning command. prism-react-renderer does
 // not bundle a bash grammar, so we tokenize this known command shape ourselves:
 // URLs, quoted strings, flags, shell punctuation, and keywords.
 function tokenize(cmd: string): Seg[] {
diff --git a/snell/panel/apps/web/src/components/CommandModal.tsx b/snell/panel/apps/web/src/components/CommandModal.tsx
index 5e92f39a..8d25e82a 100644
--- a/snell/panel/apps/web/src/components/CommandModal.tsx
+++ b/snell/panel/apps/web/src/components/CommandModal.tsx
@@ -26,7 +26,7 @@ export function CommandModal({
     staleTime: 0,
   });
 
-  const title = purpose === "install" ? "Install command" : "Upgrade to V6";
+  const title = purpose === "install" ? "Provision node" : "Upgrade node to V6";
 
   return (
     <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
@@ -49,12 +49,13 @@ export function CommandModal({
             )}
             {q.data && (
               <div className="flex flex-col gap-3">
-                <p className="text-sm text-muted">
-                  Run this on the server. The one-time token expires at{" "}
-                  {new Date(q.data.expires_at * 1000).toLocaleString()}.
-                </p>
+                <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
+                  <span className="text-muted">Token expires</span>
+                  <time className="font-mono text-xs break-all">
+                    {new Date(q.data.expires_at * 1000).toLocaleString()}
+                  </time>
+                </div>
                 <CommandBlock code={q.data.command} />
-                <p className="text-xs text-muted">Click the command to copy it.</p>
               </div>
             )}
           </Modal.Body>
diff --git a/snell/panel/apps/web/src/components/NodesTable.tsx b/snell/panel/apps/web/src/components/NodesTable.tsx
index 20ad6940..63361bce 100644
--- a/snell/panel/apps/web/src/components/NodesTable.tsx
+++ b/snell/panel/apps/web/src/components/NodesTable.tsx
@@ -47,7 +47,7 @@ function RowActions({
     <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
       {n.status === "pending" && (
         <Button size="sm" variant="primary" onPress={onInstall}>
-          Install
+          Provision
         </Button>
       )}
       <Dropdown>
@@ -177,7 +177,7 @@ export function NodesTable({ privacy }: { privacy: boolean }) {
   if (list.length === 0)
     return (
       <p className="rounded-2xl border border-black/5 bg-background-secondary p-8 text-center text-sm text-muted dark:border-white/10">
-        No nodes yet. Click “Add Node” to create one.
+        No nodes yet. Click “Add Node” to create a provisioning job.
       </p>
     );
 
diff --git a/snell/panel/apps/web/src/pages/Dashboard.tsx b/snell/panel/apps/web/src/pages/Dashboard.tsx
index 1af7c9af..de9e0306 100644
--- a/snell/panel/apps/web/src/pages/Dashboard.tsx
+++ b/snell/panel/apps/web/src/pages/Dashboard.tsx
@@ -69,7 +69,7 @@ export function Dashboard({ onLogout }: { onLogout: () => void }) {
             <Logo className="h-9 w-9" />
             <div className="leading-tight">
               <h1 className="text-lg font-semibold">Snell Panel</h1>
-              <p className="text-xs text-muted">Node &amp; subscription manager</p>
+              <p className="text-xs text-muted">Provisioning &amp; subscriptions</p>
             </div>
           </div>
           <div className="flex items-center gap-2">
diff --git a/snell/panel/apps/web/vite.config.ts b/snell/panel/apps/web/vite.config.ts
index a8975ed1..e1bad731 100644
--- a/snell/panel/apps/web/vite.config.ts
+++ b/snell/panel/apps/web/vite.config.ts
@@ -2,7 +2,7 @@ import { defineConfig } from "vite";
 import react from "@vitejs/plugin-react";
 import tailwindcss from "@tailwindcss/vite";
 
-// During `vite dev`, proxy the API + installer to the local Worker (`wrangler dev`).
+// During `vite dev`, proxy the API + provisioner to the local Worker (`wrangler dev`).
 export default defineConfig({
   plugins: [react(), tailwindcss()],
   server: {
diff --git a/snell/panel/packages/shared/src/index.ts b/snell/panel/packages/shared/src/index.ts
index 22b74e4b..980ba7db 100644
--- a/snell/panel/packages/shared/src/index.ts
+++ b/snell/panel/packages/shared/src/index.ts
@@ -92,7 +92,7 @@ export const relayNodeSchema = z.object({
 });
 export type RelayNodeInput = z.infer<typeof relayNodeSchema>;
 
-/** POST /api/nodes/:id/register — server-side callback from the installer. */
+/** POST /api/nodes/:id/register — server-side callback from the provisioner. */
 export const registerNodeSchema = z.object({
   ip: hostSchema.optional(),
   port: portSchema,
@@ -106,7 +106,7 @@ export type RegisterNodeInput = z.infer<typeof registerNodeSchema>;
 /* -------------------------------------------------------------------------- */
 
 export interface InstallCommandResponse {
-  /** The full copy-paste command to run on the server. */
+  /** The full copy-paste provisioning command to run on the server. */
   command: string;
   /** The one-time token embedded in the command (also shown for reference). */
   token: string;
diff --git a/snell/panel/scripts/snell-install.sh b/snell/panel/scripts/snell-install.sh
index 121000bd..042740ef 100755
--- a/snell/panel/scripts/snell-install.sh
+++ b/snell/panel/scripts/snell-install.sh
@@ -1,12 +1,14 @@
 #!/usr/bin/env bash
 #
-# snell-panel installer — driven by the panel's generated command.
+# snell-panel provisioner — driven by the panel's generated command.
 #
 # Subcommands:
-#   install     Install a snell-server (V5 or V6) and register it with the panel.
+#   install     Provision a snell-server (V5 or V6) and register it with the panel.
 #   uninstall   Stop + remove the service; optionally delete the panel entry.
 #   upgrade     Migrate an existing V4/V5 node to V6 in place (config + binary),
 #               then re-report to the panel.
+#   status      Show local service/config metadata.
+#   restart     Restart the local snell-server service.
 #
 # Flags:
 #   --api-url URL        Panel base URL (e.g. https://panel.example.com)
@@ -52,6 +54,14 @@ DEFAULT_SURGE_V5="v5.0.1"
 DEFAULT_SURGE_V6="v6.0.0b4"
 SURGE_BASE_URL="https://dl.nssurge.com/snell"
 
+show_help() {
+  cat <<EOF
+Usage: $0 {install|provision|upgrade|uninstall|status|restart} [flags]
+
+This provisioner is normally invoked by Snell Panel's generated one-line command.
+EOF
+}
+
 # ----------------------------------------------------------------------------
 # Flags
 # ----------------------------------------------------------------------------
@@ -83,27 +93,55 @@ PORT=""; PSK=""; REPORT_IP=""; PSK_CHANGED=0
 # ----------------------------------------------------------------------------
 # Helpers
 # ----------------------------------------------------------------------------
-show_help() {
-  sed -n '2,30p' "$0" 2>/dev/null || echo "Usage: $0 {install|uninstall|upgrade} [flags]"
-}
-
 check_root() {
   [ "$(id -u)" -eq 0 ] || { print_error "Please run as root."; exit 1; }
 }
 
 ensure_tools() {
-  local missing=() pkg
-  for pkg in curl unzip openssl; do
-    command -v "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
+  local missing=() bin
+  for bin in curl unzip openssl shuf ss sysctl systemctl; do
+    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
   done
   [ ${#missing[@]} -eq 0 ] && return 0
-  print_info "Installing dependencies: ${missing[*]}"
-  if   command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y "${missing[@]}"
-  elif command -v dnf >/dev/null 2>&1;     then dnf install -y "${missing[@]}"
-  elif command -v yum >/dev/null 2>&1;     then yum install -y "${missing[@]}"
-  elif command -v pacman >/dev/null 2>&1;  then pacman -Sy --noconfirm "${missing[@]}"
-  elif command -v zypper >/dev/null 2>&1;  then zypper install -y "${missing[@]}"
-  else print_error "Install these manually: ${missing[*]}"; exit 1; fi
+  print_info "Installing system dependencies for provisioning."
+  if command -v apt-get >/dev/null 2>&1; then
+    apt-get update -qq && apt-get install -y ca-certificates curl unzip openssl iproute2 procps coreutils
+  elif command -v dnf >/dev/null 2>&1; then
+    dnf install -y ca-certificates curl unzip openssl iproute procps-ng coreutils
+  elif command -v yum >/dev/null 2>&1; then
+    yum install -y ca-certificates curl unzip openssl iproute procps-ng coreutils
+  elif command -v pacman >/dev/null 2>&1; then
+    pacman -Sy --noconfirm ca-certificates curl unzip openssl iproute2 procps-ng coreutils
+  elif command -v zypper >/dev/null 2>&1; then
+    zypper install -y ca-certificates curl unzip openssl iproute2 procps coreutils
+  else
+    print_error "Install these manually: curl unzip openssl iproute2 procps coreutils"
+    exit 1
+  fi
+  for bin in curl unzip openssl shuf ss sysctl systemctl; do
+    command -v "$bin" >/dev/null 2>&1 || { print_error "Missing required tool after dependency install: $bin"; exit 1; }
+  done
+}
+
+backup_file() {
+  local f="$1" ts
+  [ -e "$f" ] || return 0
+  ts="$(date +%Y%m%d-%H%M%S)"
+  cp -a "$f" "${f}.bak.${ts}"
+}
+
+allow_tcp_port() {
+  local port="$1"
+  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
+    firewall-cmd --add-port="${port}/tcp" --permanent >/dev/null 2>&1 \
+      && firewall-cmd --reload >/dev/null 2>&1 \
+      && { print_success "Allowed TCP ${port} through firewalld."; return 0; }
+  fi
+  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
+    ufw allow "${port}/tcp" >/dev/null 2>&1 \
+      && { print_success "Allowed TCP ${port} through ufw."; return 0; }
+  fi
+  print_warning "Open TCP ${port} in your VPS firewall/security group if it is not reachable."
 }
 
 detect_arch_surge() {
@@ -258,7 +296,8 @@ write_systemd_unit() {
   cat > "$SERVICE_FILE" <<EOF
 [Unit]
 Description=Snell server
-After=network.target
+After=network-online.target
+Wants=network-online.target
 
 [Service]
 Type=simple
@@ -301,11 +340,11 @@ verify_token() {
     "${API_URL}/api/nodes/${NODE_ID}/verify-token?token=${TOKEN}" 2>/dev/null || echo "000")
   [ "$code" = "000" ] && return 0                        # network blip; let register decide
   if [ "$code" != "200" ]; then
-    print_error "Install token is invalid or expired (HTTP ${code})."
+    print_error "Provision token is invalid or expired (HTTP ${code})."
     print_info "Generate a fresh command from the panel and run it within 5 minutes."
     exit 1
   fi
-  print_success "Install token verified."
+  print_success "Provision token verified."
 }
 
 # Report ip/port/psk/version to the panel (consumes the one-time token).
@@ -371,12 +410,17 @@ do_install() {
   print_success "Node registered. Installing snell-server (this can take a moment)..."
 
   print_header "Installing Snell V${VERSION}"
+  backup_file "$INSTALL_BIN"
+  backup_file "$CONFIG_FILE"
+  backup_file "$META_FILE"
+  backup_file "$SERVICE_FILE"
   download_binary
   write_config
   enable_tfo
   write_systemd_unit
   systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
   systemctl restart "$SERVICE_NAME"
+  allow_tcp_port "$PORT"
   sleep 1
   systemctl is-active --quiet "$SERVICE_NAME" \
     || print_warning "Service not active; check 'journalctl -u ${SERVICE_NAME} -n 30'."
@@ -421,6 +465,10 @@ do_upgrade() {
     PSK="$(gen_psk)"; PSK_CHANGED=1
   fi
 
+  backup_file "$INSTALL_BIN"
+  backup_file "$CONFIG_FILE"
+  backup_file "$META_FILE"
+  backup_file "$SERVICE_FILE"
   migrate_config_to_v6
   print_success "Config migrated to V6 (removed obfs/ipv6, set dns-ip-preference)."
 
@@ -428,6 +476,7 @@ do_upgrade() {
   download_binary
   write_systemd_unit
   systemctl start "$SERVICE_NAME"
+  allow_tcp_port "$PORT"
   sleep 1
   systemctl is-active --quiet "$SERVICE_NAME" \
     || print_warning "Service not active after upgrade; check 'journalctl -u ${SERVICE_NAME} -n 30'."
@@ -448,13 +497,37 @@ do_upgrade() {
   print_summary
 }
 
+do_status() {
+  print_header "Snell service"
+  if systemctl list-unit-files --no-legend "${SERVICE_NAME}.service" 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
+    systemctl status "$SERVICE_NAME" --no-pager || true
+  else
+    print_warning "Service ${SERVICE_NAME} is not installed."
+  fi
+  print_header "Local metadata"
+  if [ -f "$META_FILE" ]; then
+    sed -E 's/^(psk=).+/\1****/' "$META_FILE"
+  else
+    print_warning "No metadata at ${META_FILE}."
+  fi
+}
+
+do_restart() {
+  check_root
+  systemctl restart "$SERVICE_NAME"
+  systemctl status "$SERVICE_NAME" --no-pager || true
+}
+
 # ----------------------------------------------------------------------------
 # Main
 # ----------------------------------------------------------------------------
 case "$ACTION" in
   install)   do_install ;;
+  provision|setup) do_install ;;
   uninstall) do_uninstall ;;
   upgrade)   do_upgrade ;;
+  status)    do_status ;;
+  restart)   do_restart ;;
   ""|-h|--help|help) show_help ;;
   *) print_error "Unknown command: $ACTION"; show_help; exit 1 ;;
 esac
PATCH

rm -f .github/scripts/panel-provisioning-entry.sh .github/workflows/panel-provisioning-entry.yml .github/run-panel-provisioning-entry

git diff --check
bash -n snell/panel/scripts/snell-install.sh
bash -n snell/snell-anytls.sh
snell/panel/scripts/snell-install.sh --help
node -e "for (const p of ['snell/panel/package.json','snell/panel/apps/server/package.json','snell/panel/apps/web/package.json','snell/panel/packages/shared/package.json']) JSON.parse(require('fs').readFileSync(p,'utf8'));"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add snell .github/scripts/panel-provisioning-entry.sh .github/workflows/panel-provisioning-entry.yml .github/run-panel-provisioning-entry
if git diff --cached --quiet; then
  echo "No changes to commit"
  exit 0
fi
git commit -m "feat: make snell panel the provisioning entry"
git push
