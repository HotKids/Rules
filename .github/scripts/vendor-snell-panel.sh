#!/usr/bin/env bash
set -euo pipefail

upstream_repo="https://github.com/missuo/snell-panel.git"
upstream_branch="refactor/hono-heroui"
upstream_commit="f4610e4921e68c332fdbaaf2e6f5d0c61b2f3c4e"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

git clone --depth 1 --branch "$upstream_branch" "$upstream_repo" "$tmp_dir/snell-panel"
git -C "$tmp_dir/snell-panel" fetch --depth 1 origin "$upstream_commit"
git -C "$tmp_dir/snell-panel" checkout "$upstream_commit"

git rm -f .gitmodules snell/panel || true
rm -rf snell/panel
mkdir -p snell/panel
rsync -a --exclude='.git' "$tmp_dir/snell-panel/" snell/panel/

python3 - <<'PY'
from pathlib import Path

snell_readme = Path('snell/README.md')
text = snell_readme.read_text()
text = text.replace(
    '`snell/panel/` 已作为 Git 子模块整合 `missuo/snell-panel`，提供基于 Cloudflare Workers + D1 的 Snell 节点管理面板和订阅生成服务。',
    '`snell/panel/` 已直接整合 `missuo/snell-panel` 源码，提供基于 Cloudflare Workers + D1 的 Snell 节点管理面板和订阅生成服务。',
)
text = text.replace('git submodule update --init --recursive snell/panel\n', '')
snell_readme.write_text(text)

Path('snell/PANEL.md').write_text('''# Snell Panel

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
''')

panel_readme = Path('snell/panel/README.md')
text = panel_readme.read_text()
if '## Repository integration' not in text:
    text = text.replace('---\n\n## Features', '''---

## Repository integration

This panel is vendored into `HotKids/Rules` under `snell/panel/`.
Its upstream source is [`missuo/snell-panel`](https://github.com/missuo/snell-panel).

Run all panel commands from this directory:

```bash
cd snell/panel
```

---

## Features''')
text = text.replace('`wrangler deploy` runs from the repo root', '`wrangler deploy` runs from the panel root (`snell/panel`)')
text = text.replace('git clone https://github.com/missuo/snell-panel && cd snell-panel', 'git clone https://github.com/HotKids/Rules && cd Rules/snell/panel')
panel_readme.write_text(text)

wrangler = Path('snell/panel/apps/server/wrangler.jsonc')
text = wrangler.read_text()
text = text.replace('"database_id": "60bbe93d-ac6e-4826-8c31-924cfc5dc0d3"', '"database_id": "replace-with-your-d1-database-id"')
text = text.replace('"SNELL_V6_VERSION": "v6.0.0b2"', '"SNELL_V6_VERSION": "v6.0.0b4"')
wrangler.write_text(text)

Path('snell/panel/UPSTREAM.md').write_text('''# Snell Panel upstream

This directory vendors Snell Panel from:

- Repository: https://github.com/missuo/snell-panel
- Branch: `refactor/hono-heroui`
- Commit: `f4610e4921e68c332fdbaaf2e6f5d0c61b2f3c4e`

Local integration notes:

- The panel source lives directly under `snell/panel/` in `HotKids/Rules`.
- Deployment docs use `Rules/snell/panel` as the panel root.
- `apps/server/wrangler.jsonc` uses a placeholder D1 `database_id`; replace it with the id returned by `wrangler d1 create snell-panel`.
- `SNELL_V6_VERSION` is aligned with the panel code default, `v6.0.0b4`.
''')
PY

rm -f .github/workflows/vendor-snell-panel.yml
rm -f .github/scripts/vendor-snell-panel.sh

git add -A
git add -A -f snell/panel

bash -n snell/snell-anytls.sh
bash -n snell/sync-upstream.sh
bash -n snell/panel/scripts/snell-install.sh

if git diff --cached --quiet; then
  echo "No changes to commit"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "feat: vendor snell panel source"
git push origin HEAD:master
