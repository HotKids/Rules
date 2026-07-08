# Snell Panel

`snell/panel` is a Git submodule that points to:

- Repository: https://github.com/missuo/snell-panel
- Branch: `refactor/hono-heroui`
- Commit: `f4610e4921e68c332fdbaaf2e6f5d0c61b2f3c4e`

## Initialize

After cloning this repository, initialize the panel:

```bash
git submodule update --init --recursive snell/panel
```

## Deploy

Run panel commands from the submodule directory:

```bash
cd snell/panel
bun install
bunx wrangler login
```

Then follow `snell/panel/README.md` to create the D1 database, set `ACCESS_TOKEN` and `API_TOKEN`, build, and deploy.

Before deploying, replace `apps/server/wrangler.jsonc`'s D1 `database_id` with the id returned by `wrangler d1 create snell-panel`.

## Update

To update the panel later:

```bash
git submodule update --remote snell/panel
git add snell/panel
git commit -m "chore: update snell panel"
```
