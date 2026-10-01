"""Configuration generation: pipeline."""

from .clash import (
    _sync_clash,
)
from .common import (
    _GENERAL_INJECT,
    REPO_ROOT,
    _build_general_inject,
)
from .loon import (
    _sync_loon,
)
from .parser import (
    parse_surge_profile,
    parse_sync_txt,
)
from .qx import (
    _sync_qx,
)
from .singbox import (
    _sync_singbox,
)
from .stash import (
    _sync_stash,
)
from .surfboard import (
    _sync_surfboard,
)


# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    config = parse_sync_txt()

    surge_src = config.get("Surge", {}).get("source")
    if not surge_src:
        raise ValueError("Surge 块缺少 >> 源文件路径指令")

    proxy_lines, group_lines, rule_lines, surge_mitm_lines, general_lines = \
        parse_surge_profile(REPO_ROOT / surge_src)
    print(f"  Surge: {len(group_lines)} groups, {len(rule_lines)} rules")

    # [General] 跨平台规范值：供各基座 @@占位符@@ 注入（单一来源）
    _GENERAL_INJECT.clear()
    _GENERAL_INJECT.update(_build_general_inject(general_lines))

    _sync_clash(config, proxy_lines, group_lines, rule_lines)
    _sync_stash(config, surge_mitm_lines)  # 依赖 _sync_clash 的产物，必须排在其后
    _sync_loon(config, proxy_lines, group_lines, rule_lines, surge_mitm_lines)
    _sync_qx(config, proxy_lines, group_lines, rule_lines, surge_mitm_lines)
    _sync_surfboard(config, proxy_lines, group_lines, rule_lines, general_lines, surge_src)
    _sync_singbox(config, group_lines, rule_lines)


