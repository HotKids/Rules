# Snell Panel

用于管理自己的 Snell V5 / V6 和 SS2022 服务器。部署后可在网页中添加节点、获取服务器安装命令、查看状态，并生成订阅链接。

本项目基于 [missuo/snell-panel](https://github.com/missuo/snell-panel) 重构，并在 `HotKids/Rules` 仓库内继续维护。

## 部署面板

准备一个可使用 Workers 和 D1 的 Cloudflare 账号，以及装有 Git、Node.js 20+ 的 macOS 或 Linux 环境。部署脚本会检查依赖，并按提示安装 Bun。

```bash
git clone https://github.com/HotKids/Rules snell-panel-source
ln -s snell-panel-source/snell-panel snell-panel
cd snell-panel
./deploy.sh
```

按终端提示授权 Cloudflare、创建或选择 D1 数据库，并设置 `ACCESS_TOKEN` 和 `API_TOKEN`。部署完成后，打开终端显示的面板地址，使用 `ACCESS_TOKEN` 登录。

`ACCESS_TOKEN` 用于登录和管理面板；`API_TOKEN` 用于服务端操作。请保存自己设置的值；Cloudflare 无法读回已保存的 secret 原文。部署摘要默认隐藏完整值，需要在本机查看本次生成的值时，可用 `./deploy.sh --show-secrets`。

没有浏览器的远程主机可以使用有 Workers、D1 权限的 Cloudflare API Token，设置 `CLOUDFLARE_API_TOKEN` 后再部署，详见[部署说明](docs/DEPLOY.md)。

## 添加节点与订阅

1. 登录面板，点击 **Add node**，填写名称并选择 Snell 版本或 SS2022 加密方式。IP 和端口可以预填。
2. 在新节点上点击 **Provision**，复制安装命令，在对应的 Linux 服务器上以 root 身份执行。服务器需要使用 systemd，并能访问面板及软件下载地址。
3. 等待安装完成、节点显示为 **active**，再点击 **Subscription**，选择 Surge、Shadowrocket 或 Mihomo 格式，复制链接到客户端。

订阅仅包含已启用且安装成功的节点。可以按名称筛选、控制旗帜显示；Surge 格式还可填写 `underlying-proxy`。选择订阅格式后，仍需确认客户端支持所选协议、版本和加密方式。

节点菜单支持改名、从订阅中隐藏、添加中转记录，以及为 Snell V5 生成升级到 V6 的命令。安装和升级命令需要到服务器上执行；添加中转记录后，端口转发也需自行配置。

订阅链接包含访问凭据。需要更换时，在 **Subscription** 中点击 **Reset token**，再更新客户端里的链接；旧链接会立即失效。

## 更新面板

```bash
cd snell-panel
./update.sh
```

保留完整的 Git 仓库和上述软链接，便于脚本获取更新。更新默认保留现有登录凭据；如提示有未提交修改，请先处理本地修改再重试。

## 备份与恢复

```bash
cd snell-panel
./backup.sh
./restore.sh backups/备份文件.sql
```

备份保存在 `backups/` 中。恢复会向当前配置的远程 D1 数据库写入数据，运行时会要求确认；它不会恢复服务器上的代理程序，也不会恢复 Cloudflare 中的 secret。

## 遇到问题

部署或访问异常时，在项目目录运行 `./doctor.sh`，按检查结果处理。已有 D1 数据库可在部署时复用，无需先删除数据库。

如果旧安装只有单独复制出来的 `snell-panel` 子目录，请按上面的 Git 克隆方式重新准备代码，并保留原数据库配置后部署。

更多说明：[部署](docs/DEPLOY.md) · [更新](docs/UPDATE.md) · [备份](docs/BACKUP.md) · [凭据](docs/SECURITY.md)。

