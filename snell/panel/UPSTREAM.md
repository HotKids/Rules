# Snell Panel upstream

This directory vendors Snell Panel from:

- Repository: https://github.com/missuo/snell-panel
- Branch: `refactor/hono-heroui`
- Commit: `f4610e4921e68c332fdbaaf2e6f5d0c61b2f3c4e`

Local integration notes:

- The panel source lives directly under `snell/panel/` in `HotKids/Rules`.
- Deployment docs use `Rules/snell/panel` as the panel root.
- `apps/server/wrangler.jsonc` uses a placeholder D1 `database_id`; replace it with the id returned by `wrangler d1 create snell-panel`.
- `SNELL_V6_VERSION` is aligned with the panel code default, `v6.0.0b4`.
