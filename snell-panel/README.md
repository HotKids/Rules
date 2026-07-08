# Snell Panel

Cloudflare Workers + D1 + Hono 后端，Vite / React / HeroUI 前端，同 Worker 托管 SPA 的 Snell V5/V6 与 SS2022 节点生命周期管理面板。

## 一键部署

```bash
git clone https://github.com/HotKids/Rules
cd Rules/snell-panel
chmod +x deploy.sh
./deploy.sh
```

## 一键更新

```bash
cd Rules/snell-panel
./update.sh
```

## 备份 / 恢复

```bash
cd Rules/snell-panel
./backup.sh
./restore.sh backups/<file.sql>
```

## 常见问题

### D1 已存在怎么办？

运行 `./deploy.sh`，选择复用现有 D1，并粘贴 Cloudflare D1 的 `database_id`。脚本不会覆盖 `apps/server/wrangler.jsonc` 中已有的有效 `database_id`。

### secrets 如何处理？

部署时可以跳过、覆盖、手动隐藏输入或回车自动生成 `ACCESS_TOKEN` / `API_TOKEN`。Cloudflare secret 写入后无法读回原文，请保存自动生成的 token。

### 如何排查部署问题？

运行 `./doctor.sh`。更多说明见 `docs/DEPLOY.md`、`docs/UPDATE.md`、`docs/BACKUP.md`、`docs/SECURITY.md`、`docs/OPERATIONS.md`。
