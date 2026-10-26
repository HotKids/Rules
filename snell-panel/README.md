# Snell Panel

Snell V5 / V6 与 SS2022 节点管理面板，支持节点配置、服务器安装命令、状态查询及订阅生成。

本项目基于 [missuo/snell-panel](https://github.com/missuo/snell-panel) 重构，在本仓库持续维护。

## 部署

部署环境需具备 Git、Node.js 20+，支持 macOS 或 Linux；Cloudflare 账号需开通 Workers 和 D1。脚本将检查依赖并提示安装 Bun。

```bash
git clone https://github.com/HotKids/Rules snell-panel-source
ln -s snell-panel-source/snell-panel snell-panel
cd snell-panel
./deploy.sh
```

按提示授权 Cloudflare、创建或选择 D1 数据库，并设置 `ACCESS_TOKEN`、`API_TOKEN`。部署后访问终端显示的地址，使用 `ACCESS_TOKEN` 登录。

`ACCESS_TOKEN` 用于面板管理，`API_TOKEN` 用于服务端操作，均需自行保存；Cloudflare 不支持读取已保存的 secret 原文。部署摘要默认隐藏凭据，可通过 `./deploy.sh --show-secrets` 在本机查看本次生成值。

无浏览器环境可设置具有 Workers、D1 权限的 `CLOUDFLARE_API_TOKEN` 后部署，详见[部署说明](docs/DEPLOY.md)。

## 节点与订阅

1. 点击 **Add node**，填写名称，选择 Snell 版本或 SS2022 加密方式；IP、端口可预填。
2. 点击节点的 **Provision**，在对应 Linux 服务器上以 root 身份执行安装命令。服务器需使用 systemd，并可访问面板及软件下载地址。
3. 节点显示 **active** 后，点击 **Subscription**，选择 Surge、Shadowrocket 或 Mihomo 格式，将订阅链接导入客户端。

订阅仅包含已启用且安装成功的节点，支持名称筛选、旗帜显示及 Surge `underlying-proxy` 设置。客户端须支持所选协议、版本和加密方式。

节点菜单提供改名、隐藏、中转记录及 Snell V5 升级 V6 命令。安装与升级命令均需在服务器执行，中转端口转发需另行配置。

订阅链接含访问凭据。点击 **Reset token** 后，旧链接立即失效，须同步更新客户端订阅。

## 更新

```bash
cd snell-panel
./update.sh
```

更新需保留完整 Git 仓库及上述软链接；如存在未提交修改，应处理后重试。现有登录凭据默认保留。

## 备份与恢复

```bash
cd snell-panel
./backup.sh
./restore.sh backups/备份文件.sql
```

备份位于 `backups/`。恢复经确认后写入当前配置的远程 D1 数据库，不包含服务器代理程序或 Cloudflare secret。

## 故障排查

部署或访问异常时，运行 `./doctor.sh` 并按结果处理。现有 D1 数据库可直接复用。旧安装若仅保留独立子目录，需按上述方式重新克隆，并保留原数据库配置后部署。

相关说明：[部署](docs/DEPLOY.md) · [更新](docs/UPDATE.md) · [备份](docs/BACKUP.md) · [凭据](docs/SECURITY.md)。
