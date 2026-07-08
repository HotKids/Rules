#!/usr/bin/env bash
set -euo pipefail

git mv snell/panel snell-panel
git rm -f snell/README.md snell/snell-anytls.sh

python3 <<'PY'
from pathlib import Path

readme = Path('snell-panel/README.md')
text = readme.read_text()
text = text.replace(
    'This panel is part of the `HotKids/Rules` Snell Toolkit and lives under `snell/panel/`.',
    'This project lives directly under `Rules/snell-panel`.\n\nIt is rewritten from [missuo/snell-panel](https://github.com/missuo/snell-panel) and maintained as part of `HotKids/Rules`. The upstream project is used as the source inspiration; this tree is direct source code in this repository, not a submodule.',
)
text = text.replace('cd snell/panel', 'cd snell-panel')
text = text.replace('panel root (`snell/panel`)', 'panel root (`snell-panel`)')
text = text.replace('git clone https://github.com/HotKids/Rules && cd Rules/snell/panel', 'git clone https://github.com/HotKids/Rules && cd Rules/snell-panel')
readme.write_text(text)

design = Path('snell-panel/docs/DESIGN.md')
text = design.read_text()
text = text.replace(
    'This document is the design record for the full rewrite of Snell Panel. It is committed\n**before** any implementation so the rationale behind the architecture is preserved.',
    'This document is the design record for the `Rules/snell-panel` rewrite. The project is\nbased on [missuo/snell-panel](https://github.com/missuo/snell-panel), then adapted into\nthe `HotKids/Rules` tree as direct source code with a Panel-first provisioning flow.',
)
text = text.replace('Shipping a no-panel standalone installer — OpenSnell\'s repo already provides one.', 'Shipping a no-panel standalone script — provisioning is part of the panel flow.')
text = text.replace('/install.sh   serves the installer script', '/install.sh   serves the panel provisioner')
text = text.replace('snell-server VPS (bash installer)', 'snell-server VPS (bash provisioner)')
text = text.replace('serve the installer script', 'serve the panel provisioner')
text = text.replace('matching the constants in OpenSnell\'s installer', "matching the provisioner's defaults")
text = text.replace('## 7. Installer script (`scripts/snell-install.sh`)', '## 7. Panel provisioner (`scripts/snell-install.sh`)')
text = text.replace('Modeled on OpenSnell\'s polished, version-aware `install.sh`, adapted to **non-interactive\nflag mode** plus a panel register callback. Reused patterns: 32-char `gen_psk`, arch', 'Adapted into **non-interactive flag mode** plus a panel register callback. Reused patterns: 32-char `gen_psk`, arch')
text = text.replace('The installer writes a hidden `/etc/snell/.install_meta`', 'The provisioner writes a hidden `/etc/snell/.install_meta`')
design.write_text(text)
PY

rm -f .github/scripts/move-snell-panel.sh .github/workflows/move-snell-panel.yml .github/run-move-snell-panel

git diff --check
bash -n snell-panel/scripts/snell-install.sh
snell-panel/scripts/snell-install.sh --help
node -e "for (const p of ['snell-panel/package.json','snell-panel/apps/server/package.json','snell-panel/apps/web/package.json','snell-panel/packages/shared/package.json']) JSON.parse(require('fs').readFileSync(p,'utf8'));"
if rg -n 'snell-anytls|snell/panel|Rules/snell/panel|Rules/snell(/|$)' snell-panel README.md .github --glob '!snell-panel/bun.lock'; then
  echo 'old snell paths still present' >&2
  exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "No changes to commit"
  exit 0
fi
git commit -m "refactor: move snell panel to top-level project"
git push
