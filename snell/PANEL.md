# Snell Panel

`snell/panel` contains the vendored source for Snell Panel.

Upstream source:

- Repository: https://github.com/missuo/snell-panel
- Branch: `refactor/hono-heroui`
- Commit: `f4610e4921e68c332fdbaaf2e6f5d0c61b2f3c4e`

## Deploy

Run panel commands from the vendored source directory:

```bash
cd snell/panel
bun install
bunx wrangler login
```

Then follow `snell/panel/README.md` to create the D1 database, set `ACCESS_TOKEN` and `API_TOKEN`, build, and deploy.

Before deploying, replace `apps/server/wrangler.jsonc`'s D1 `database_id` with the id returned by `wrangler d1 create snell-panel`.

## Update

To update the vendored source later, copy the tracked files from the upstream repository into `snell/panel/`, review the diff, then commit the changes in this repository.
