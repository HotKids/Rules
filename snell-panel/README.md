# Snell Panel

Cloudflare Workers + D1 + Hono 后端，Vite / React / HeroUI 前端，同 Worker 托管 SPA 的 Snell V5/V6 与 SS2022 节点生命周期管理面板。

本项目基于 [missuo/snell-panel](https://github.com/missuo/snell-panel) 重构，并在 `HotKids/Rules` 仓库内继续维护。

## 一键部署

```bash
git clone https://github.com/HotKids/Rules snell-panel-source
ln -s snell-panel-source/snell-panel snell-panel
cd snell-panel
chmod +x deploy.sh
./deploy.sh
```

## 一键更新

```bash
cd snell-panel
./update.sh
```

## 备份 / 恢复

```bash
cd snell-panel
./backup.sh
./restore.sh backups/<file.sql>
```

## 常见问题

### D1 已存在怎么办？

运行 `./deploy.sh`。脚本会自动识别并复用 `apps/server/wrangler.jsonc` 中已有的有效 `database_id`；只有未配置时才会询问是否复用现有 D1。

### secrets 如何处理？

部署时可以跳过、覆盖、手动隐藏输入或回车自动生成 `ACCESS_TOKEN` / `API_TOKEN`。最终摘要默认只显示脱敏 token；确需明文输出时使用 `./deploy.sh --show-secrets`。Cloudflare secret 写入后无法读回原文，请妥善保存自动生成的 token。

### 如何排查部署问题？

运行 `./doctor.sh`。部署脚本也会在发布后自动检查 Worker URL，避免误以为 Cloudflare 默认的空 Worker 页面代表部署成功。

### update.sh 提示不是 Git checkout 怎么办？

推荐使用上面的一键部署命令：实际 Git 仓库保留在 `snell-panel-source`，日常通过软链接 `snell-panel` 进入项目，终端目录名仍显示 `snell-panel`，`./update.sh` 也可以自动拉取 GitHub 最新代码。旧版如果已经把子目录单独移动出来，可以临时执行 `UPDATE_REPO_URL=https://github.com/HotKids/Rules.git ./update.sh` 让脚本备份当前目录并重新 clone。

更多说明见 `docs/DEPLOY.md`、`docs/UPDATE.md`、`docs/BACKUP.md`、`docs/SECURITY.md`、`docs/OPERATIONS.md`。

