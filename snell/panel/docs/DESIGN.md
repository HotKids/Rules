# Snell Panel — Design

> Status: accepted · Stack: Hono (Cloudflare Workers) + D1 · HeroUI v3 SPA · Bun tooling

This document is the design record for the full rewrite of Snell Panel. It is committed
**before** any implementation so the rationale behind the architecture is preserved.

---

## 1. Context & goals

The previous Snell Panel was a Go (Gin) + PostgreSQL backend whose web UI lived in a
*separate* repository (a Next.js + shadcn app). This rewrite collapses backend and panel
into **one monorepo** on a modern, edge-native stack and redesigns three areas the owner
called out:

1. **Two independent secrets** — a panel **Access Token** (control plane) and a backend
   **API Token** (data-plane writes), which must never be the same value or derivable from
   each other.
2. **"Add node, then Install"** — the panel creates a *pending* node first (choose Snell
   **V5 or V6**, name, and optionally **pre-fill IP/Port**); pressing **Install** yields a
   copy-paste command to run on the server, which then back-fills `ip/port/psk` and flips
   the node to *active*.
3. **Config-migrating upgrade** — replace the old "jump upgrade" with an in-place upgrade
   that works across the V5→V6 config break (validate PSK, strip removed keys, swap binary,
   re-report to the panel). V4↔V5 are compatible, so V4→V6 uses the same path.

### Non-goals

- Multi-user accounts / RBAC. A single operator authenticates with one Access Token.
- Migrating the iOS app (`Snell Hub`) — out of scope here.
- Shipping a no-panel standalone installer — OpenSnell's repo already provides one.

---

## 2. Architecture

```
┌──────────────────────── Cloudflare Worker (workerd) ────────────────────────┐
│  Hono app                                                                    │
│   ├─ /api/*        admin + data-plane + subscription endpoints               │
│   ├─ /install.sh   serves the installer script                               │
│   └─ static assets (apps/web/dist)  ── SPA fallback for all other paths       │
│  Bindings:  DB = D1 (SQLite)                                                  │
│  Secrets:   ACCESS_TOKEN, API_TOKEN                                           │
│  Vars:      SNELL_V5_VERSION, SNELL_V6_VERSION                                │
└──────────────────────────────────────────────────────────────────────────────┘
        ▲ same origin (no CORS)                         ▲ one-time install token
        │                                               │
   HeroUI v3 SPA (browser)                       snell-server VPS (bash installer)
```

**Tooling vs runtime.** **Bun** is the package manager / workspace / script + test runner
(`bun install`, `bunx wrangler dev|deploy`). The **production runtime is workerd**, not
Bun — D1 is a Worker binding, so the worker code stays Web-standard + Hono's Cloudflare
adapter and must **not** use Bun-only APIs (`Bun.serve`, `bun:sqlite`). Local dev runs on
`wrangler dev` (workerd via Miniflare with local D1), not the Bun runtime.

### Repo layout (Bun workspace)

```
apps/
  server/        # Hono Worker: API + serves the SPA assets
    src/index.ts                  # app entry, route mounting, assets fallback
    src/routes/{nodes,register,subscribe,install}.ts
    src/middleware/auth.ts        # requireAccess / requireApiToken / requireInstallToken
    src/db/{schema.ts,client.ts}  # Drizzle (D1)
    src/lib/{geoip.ts,subscription.ts,token.ts,versions.ts}
    wrangler.jsonc
    drizzle/                      # generated migrations
  web/           # Vite + React + HeroUI v3 SPA → builds to apps/web/dist
    src/{App.tsx, api/client.ts, pages/*, components/*}
packages/
  shared/        # shared TS types + zod schemas (Node, version enum, API DTOs)
scripts/
  snell-install.sh                # param-driven install/uninstall/upgrade
docs/
  DESIGN.md                       # this document
```

---

## 3. Security / credential model

Three credentials, each scoped to a different trust boundary:

| Credential | Lives in | Guards | Notes |
|---|---|---|---|
| **ACCESS_TOKEN** | Worker secret; typed into the panel; also the `?token=` of the subscription URL | every `/api/*` admin endpoint via `Authorization: Bearer` | The frontend secret. Never sent to a VPS. |
| **API_TOKEN** | Worker secret; **never leaves the backend** | accepted on data-plane endpoints (register / delete / upgrade) for direct automation | The backend master write secret. Independent of ACCESS_TOKEN. |
| **one-time install token** | minted per node on demand, returned to the panel, embedded in the install command | a single node's register/upgrade callback; **single-use + TTL** | Ephemeral. The only credential that ever lands on a VPS. |

Why split them: the install command is copy-pasted onto servers and lingers in shell
history, so it must **not** carry a long-lived secret. The panel admin authenticates with
the Access Token in the browser; the backend mints short-lived per-node tokens for servers;
the master API Token stays server-side. `middleware/auth.ts` exposes the three guards;
register/upgrade accept a valid one-time token **or** the master `API_TOKEN`.

---

## 4. Data model (D1 / Drizzle)

```
nodes
  id             integer  pk autoincrement
  node_id        text     unique not null        -- uuid, used in URLs/commands
  node_name      text     not null
  version        text     not null               -- '5' | '6'
  status         text     not null default 'pending'   -- 'pending' | 'active'
  ip             text                             -- null until prefilled or registered
  port           integer                          -- null until prefilled or randomized
  psk            text                             -- null until registered
  country_code   text
  isp            text
  asn            integer
  tfo            integer  not null default 1      -- bool
  ip_prefilled   integer  not null default 0      -- if 1, register keeps this ip
  port_prefilled integer  not null default 0      -- if 1, install uses this port
  created_at     integer  not null
  registered_at  integer

install_tokens
  token       text    pk
  node_id     text    not null references nodes(node_id) on delete cascade
  purpose     text    not null default 'install'  -- 'install' | 'upgrade'
  expires_at  integer not null
  used_at     integer                             -- set when consumed (single-use)
```

**Pre-fill rule.** When the admin pre-fills IP and/or Port, store them and set the
`*_prefilled` flags. The install command then carries `--ip` / `--port`, the script uses
those values verbatim, and the register endpoint keeps pre-filled values authoritative
(defense against a script reporting something different).

---

## 5. Backend API (Hono, under `/api`)

**Admin** — `Authorization: Bearer <ACCESS_TOKEN>`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/nodes` | list all nodes (pending + active) |
| POST | `/api/nodes` | create a draft: `{ version:'5'|'6', node_name, ip?, port?, tfo? }` → pending node |
| GET | `/api/nodes/:id/install` | mint one-time token → `{ command, token, expires_at }` |
| GET | `/api/nodes/:id/upgrade` | mint one-time token → upgrade command |
| PATCH | `/api/nodes/:id` | rename / change IP (re-resolves geo) |
| DELETE | `/api/nodes/:id` | delete node |
| GET | `/api/snell-versions` | resolved `{ v5, v6 }` from Worker vars |

**Data-plane** — one-time install token **or** `API_TOKEN`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/nodes/:id/register` | `{ ip?, port, psk, version }` → fill geo, `status:'active'`, consume token |

**Public:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/subscribe?token=<ACCESS_TOKEN>&format=surge\|shadowrocket\|mihomo&filter=&flag=&via=` | render subscription |
| GET | `/install.sh` | serve the installer script |

**GeoIP** (`lib/geoip.ts`): `GET https://api.ip.sb/geoip/<ip>` (works from workerd). If the
address is a domain, resolve an A record via DoH (`https://cloudflare-dns.com/dns-query`)
first. Geo is best-effort — blank on failure. Replaces the old `utils.GetIPInfoFromDomainOrIP`.

**Subscription** (`lib/subscription.ts`): port the three formatters and the country→flag
emoji helper from the old Go `handlers` verbatim in behavior (Surge line, Shadowrocket
`snell://` base64 URI, Mihomo YAML proxy entry), including `tfo`, `via`/underlying-proxy,
`filter`, and `flag` handling.

---

## 6. Node lifecycle & the generated command

`GET /api/nodes/:id/install` returns a command shaped like:

```bash
bash <(curl -fsSL https://panel.example.com/install.sh) install \
  --api-url https://panel.example.com \
  --node-id <NODE_ID> \
  --token <ONE_TIME_TOKEN> \
  --version 6 \
  --snell-version v6.0.0b4          # backend injects exact "latest" for the family
  [--ip <PREFILL_IP>] [--port <PREFILL_PORT>] [--name <NODE_NAME>]
```

"Latest V5/V6" is owned centrally by Worker vars `SNELL_V5_VERSION` (default `v5.0.1`) and
`SNELL_V6_VERSION` (default `v6.0.0b4`) — matching the constants in OpenSnell's installer.
The backend resolves family→exact version and passes `--snell-version`, so bumping a
version is an env change, not a script edit.

Flow: **create draft (pending)** → **Install** mints a token and returns the command →
operator runs it → script installs snell + registers → node becomes **active** with real
`ip/port/psk` → subscription reflects it immediately (regenerated from the DB).

---

## 7. Installer script (`scripts/snell-install.sh`)

Modeled on OpenSnell's polished, version-aware `install.sh`, adapted to **non-interactive
flag mode** plus a panel register callback. Reused patterns: 32-char `gen_psk`, arch
detection for both Surge and OpenSnell binaries, `download_surge <version>` (handles
`v5.0.1` and `v6.0.0b4`; v6 has no armv7l build), version-branched config builder, systemd
unit, firewall, geo fetch, and a `META_FILE` at `/etc/snell/.install_meta`. Paths:
`INSTALL_BIN=/usr/local/bin/snell-server`, `CONFIG_DIR=/etc/snell`,
`SERVICE_NAME=snell-server`.

Binary source per `--version`: **V6** → Surge official `v6.0.0b4` (closed beta, Linux only);
**V5** → Surge official `v5.0.1` (default) or OpenSnell GPLv3 (optional `--variant opensnell`,
all-arch).

**install**: parse flags → pick binary by version at the exact `--snell-version` → port =
`--port` or random free → IP = `--ip` or `curl -s -4 ip.sb` → generate a compliant PSK →
write a version-specific config (V6: `dns-ip-preference`, no `obfs`/`ipv6`; V5: classic
`obfs`/`ipv6`) → systemd unit → `POST $API_URL/api/nodes/$NODE_ID/register?token=$TOKEN` →
persist meta.

**uninstall**: stop + remove service/dir. The primary delete path is the panel (admin
clicks Delete); the script does a best-effort `DELETE /api/nodes/:id` when a credential is
available.

**upgrade (V4/V5 → V6)** — the redesigned feature:

1. **Validate PSK** for V6 (16–255 bytes). If non-compliant, regenerate a compliant PSK and
   mark it changed.
2. **Migrate the config in place**: strip keys removed in V6 (`obfs`, `obfs-opts`, `ipv6`),
   ensure `dns-ip-preference = default`, keep `listen`/`psk`; update meta.
3. **Swap the binary** to V6 (`download_surge v6.0.0b4`); fix systemd `ExecStart`.
4. **Restart**, then **re-report** to the panel (re-`register` / `PATCH`) with `version=6`
   and the new PSK if it changed. Because subscriptions are generated from the DB, a PSK
   change propagates to clients automatically once the node re-reports.

---

## 8. Frontend (HeroUI v3 SPA, `apps/web`)

Fresh build. Vite + React + TS + **Tailwind v4** (`@tailwindcss/vite`) + `@heroui/react` +
`@heroui/styles` + `tailwind-variants`. TanStack Query + a typed fetch client over the
`packages/shared` DTOs. Same origin as the API (served by the Worker) → no CORS.

HeroUI v3 conventions (per the `heroui-react` skill): Tailwind v4 is mandatory; **no
`<HeroUIProvider>`**; **compound components** (`Card.Header`, `Modal.*`, `Table.*`); use
**`onPress`** not `onClick`; import `@import "tailwindcss";` before `@import "@heroui/styles";`;
dark/light via `class="dark"` + `oklch` variables.

Screens:

- **Login gate** — enter the Access Token; store in `localStorage`; send as Bearer.
- **Nodes table** — name, status chip (pending/active), version, IP, port, country flag,
  ISP, row actions.
- **Add Node modal** — version select (V5/V6), name, a "pre-fill IP/Port" switch revealing
  optional inputs.
- **Install / Upgrade modal** — generated command + copy button + token expiry.
- **Subscription card** — Surge / Shadowrocket / Mihomo URLs with copy.

---

## 9. Deployment & data migration

- `wrangler.jsonc`: `main` → server entry; `assets` → `apps/web/dist` with
  `not_found_handling: "single-page-application"` and `run_worker_first` for `/api/*` and
  `/install.sh`; `d1_databases` binding; `vars` `SNELL_V5_VERSION` / `SNELL_V6_VERSION`;
  secrets `ACCESS_TOKEN` / `API_TOKEN` via `wrangler secret put`.
- Build & deploy: `bun run --filter web build` then `bunx wrangler deploy`.
- **One-time data migration** (Supabase Postgres → D1): export `entries`, map to `nodes`
  (`status='active'`, keep `version`/`tfo`, `*_prefilled=0`), import with
  `wrangler d1 execute --file`. A small helper script + README cover this.

---

## 10. Verification

- **Local**: `bunx wrangler dev` (local D1) + `vite dev`. Create a draft → fetch the install
  command → simulate the server with `curl` to `POST /api/nodes/:id/register` → confirm the
  node flips to `active` and `/api/subscribe` emits correct lines for all three formats
  (compare against the old Go output).
- **Pre-fill**: draft with pre-filled IP/Port → command includes `--ip/--port`; register
  keeps those exact values.
- **Tokens**: install token is single-use + expiring; `ACCESS_TOKEN` ≠ `API_TOKEN`; the
  command exposes neither long-lived secret.
- **Upgrade**: run `upgrade --to 6` on a sample V5 config with `obfs`/`ipv6` and a too-short
  PSK → keys stripped, `dns-ip-preference` added, PSK regenerated, binary swapped, panel
  re-reports `version=6` + new PSK.

---

## 11. Addendum — refinements

Decisions added after the original design, all implemented and verified:

- **Relay / transit nodes.** `POST /api/nodes/:id/relay { node_name, ip, port }` clones an
  **active** origin node's PSK + version into a new node at a different IP/port, created
  `active` immediately (no install needed — the PSK is already known). Relaying a `pending`
  node is rejected (400).
- **Rotatable subscribe token.** A `settings` key/value table holds a `subscribe_token`.
  The subscription URL uses this token, **not** `ACCESS_TOKEN` — so the panel login secret
  never appears in a sub URL. `GET /api/settings` returns it; `POST
  /api/settings/subscribe-token/reset` rotates it (old URLs stop working). The panel's
  Subscription card builds the URL from toggles (format / flag / filter / via) and has a
  **Reset token** button. (VLESS is intentionally omitted — Snell is not VLESS.)
- **Uninstall by Node ID, not IP.** The installer writes a hidden `/etc/snell/.install_meta`
  holding `node_id`, `api_url`, `variant`, etc. `uninstall` reads `node_id` from it and calls
  `DELETE /api/nodes/<node_id>` — IP is not relied on (it may not be unique). The DELETE
  endpoint accepts `ACCESS_TOKEN` (panel) or `API_TOKEN` (passed to uninstall as `--api-token`).
- **Legacy import.** `scripts/import-legacy.ts` fetches the old Gin panel's `/entries`,
  drops V5 nodes (the legacy USIT7 node — V5/V6 don't interoperate), preserves each
  `node_id` (uuid) for continuity, sets `status='active'`, and emits SQL **without** the
  integer `id` so D1 re-assigns ids from 1. Apply with `wrangler d1 execute --file`.
</content>
