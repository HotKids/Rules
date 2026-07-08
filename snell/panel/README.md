<div align="center">
  <img src="apps/web/public/favicon.svg" width="76" alt="Snell Panel" />
  <h1>Snell Panel</h1>
  <p>Provision Snell proxy nodes and generate subscription links.<br/>
  Hono on <b>Cloudflare Workers + D1</b>, with a <b>HeroUI v3</b> panel served from the same Worker.</p>
</div>

---

## Project integration

This panel is part of the `HotKids/Rules` Snell Toolkit and lives under `snell/panel/`.

Run all panel commands from this directory:

```bash
cd snell/panel
```

---

## Features

- **V5 / V6 nodes** with a Panel-first provisioning flow — create a node, run the generated one-line command on your server, and it back-fills `ip/port/psk`.
- **Two independent secrets**: a panel **Access Token** and a backend **API Token**; servers only ever receive a **per-node one-time install token**.
- **Relay / transit nodes** — clone an active node behind a different IP/port.
- **Enable / disable** — hide a node from subscriptions while it keeps running.
- **Subscriptions** in **Surge / Shadowrocket / Mihomo**, with a **rotatable** subscribe token and flag / filter / relay options.
- **In-place V4/V5 → V6 upgrade** — validates the PSK, strips removed config keys, swaps the binary, and re-reports.
- **Responsive panel** — dense table on desktop, cards on mobile, light/dark themes.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Hono on Cloudflare Workers, D1 (SQLite) via Drizzle |
| Frontend | Vite + React + HeroUI v3 (Tailwind v4), served as Worker assets |
| Tooling | Bun (workspace, scripts), Wrangler (deploy) |

```
apps/server      Hono Worker (API + serves the SPA) + D1 schema/migrations
apps/web         Vite + React + HeroUI v3 SPA  -> builds to apps/web/dist
packages/shared  Shared TS types + zod schemas
scripts          snell-install.sh (Panel provisioner) + import-legacy.ts
```

---

## Deploy

Deploy from a local clone with the Wrangler CLI. There is **no one-click deploy** —
the panel needs a D1 database and two secrets that only you can create, and the SPA
must be built before the Worker is uploaded.

`wrangler deploy` runs from the panel root (`snell/panel`) — the committed
`.wrangler/deploy/config.json` points it at `apps/server/wrangler.jsonc`. The D1 and
secret commands read the config from the current directory, so they run from
`apps/server` (where `wrangler.jsonc` lives).

```bash
git clone https://github.com/HotKids/Rules && cd Rules/snell/panel
bun install

bunx wrangler login

# D1 + secrets are set up from apps/server (where wrangler.jsonc lives)
cd apps/server

# create D1, then paste the printed database_id into wrangler.jsonc
bunx wrangler d1 create snell-panel
bunx wrangler d1 migrations apply snell-panel --remote

# set the two secrets (independent of each other)
printf '%s' "<access-token>" | bunx wrangler secret put ACCESS_TOKEN
printf '%s' "<api-token>"    | bunx wrangler secret put API_TOKEN

# build the SPA + deploy the Worker (serves the SPA + API) from the panel root
cd ../..
bun run build
bunx wrangler deploy
```

Generate strong tokens with: `openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; echo`

Open the deployed URL and log in with your **Access Token**.

---

## Local development

```bash
bun install

# terminal 1 — Worker + local D1
cd apps/server
cp .dev.vars.example .dev.vars          # set ACCESS_TOKEN / API_TOKEN
bun run db:migrate:local
bun run dev                             # http://localhost:8787

# terminal 2 — SPA (proxies /api to the Worker)
cd apps/web && bun run dev              # http://localhost:5173
```

---

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `ACCESS_TOKEN` | secret | Panel login (control plane) |
| `API_TOKEN` | secret | Data-plane master write token (never leaves the backend) |
| `SNELL_V5_VERSION` | var | Exact V5 build (default `v5.0.1`) |
| `SNELL_V6_VERSION` | var | Exact V6 build (default `v6.0.0b4`) |

The **subscription token** is separate, stored in D1, and rotatable from the panel
(Subscription → **Reset token**) — independent of `ACCESS_TOKEN`.

---

## Node lifecycle

1. **Add Node** — pick V5/V6, name, optionally pre-fill IP/Port → a `pending` node.
2. **Provision** — copy the generated one-line command, run it on the server; it installs
   Snell, writes systemd, enables TFO, tries to open the TCP port, and registers
   `ip/port/psk` → the node becomes `active`.
3. **Relay** — clone an active node behind a different IP/port (transit front).
4. **Upgrade** — migrate a V4/V5 node to V6 in place (config migration + binary swap).

The provisioner (`scripts/snell-install.sh`, served by the Worker at `/install.sh`) stores
`node_id` in `/etc/snell/.install_meta`, so `uninstall` removes the panel entry **by node id**,
not by IP.

---

## Import from the legacy panel

```bash
bun scripts/import-legacy.ts "https://old-panel/entries?token=..." > import.sql
bunx wrangler d1 execute snell-panel --remote --file=import.sql -c apps/server/wrangler.jsonc
```

Drops V5 nodes, preserves each `node_id`, and re-assigns integer ids from 1.

---

## License

See [`LICENSE`](LICENSE).
