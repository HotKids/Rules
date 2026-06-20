#!/bin/bash
set -euo pipefail

# 仅在远程 web 环境运行（本地 ~/.claude/skills 持久存在，无需每次复制）
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# 将仓库内的 skills 复制到 ~/.claude/skills/
SKILLS_SRC="${CLAUDE_PROJECT_DIR}/.claude/skills"
if [ -d "$SKILLS_SRC" ]; then
  mkdir -p ~/.claude/skills
  cp -r "$SKILLS_SRC"/. ~/.claude/skills/
fi
