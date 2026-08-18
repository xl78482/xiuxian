# XiuXian

Telegram Mini App 自动发卡平台。当前版本使用零第三方运行时依赖的 Node.js 22 + SQLite，运行时支付统一使用 DujiaoPay，买家登录统一使用 Telegram `initData`。

当前版本：`1.0.16`

版本更新内容见 [CHANGELOG.md](./CHANGELOG.md)，发布规则见 [RELEASING.md](./RELEASING.md)，尚未完成的上线与运营能力见 [ROADMAP.md](./ROADMAP.md)。

## 已实现

- Telegram Mini App 登录，服务端验签 `initData`
- 商品、分类、SKU、库存和卡密批次管理
- AES-256-GCM 加密存储卡密，HMAC 指纹查重
- 订单幂等、库存预留、支付回调幂等、异步发卡
- DujiaoPay HMAC 请求签名和原始 Webhook body 验签
- Tron USDT 支付配置，保留后续 EPUSDT 等适配器边界
- 买家端订单、支付轮询、卡密查看/复制、支付会话恢复、售后入口
- 管理后台数据看板、用户管理、商品/SKU、卡密导入、支付渠道配置、订单和发卡重试
- API 与 Worker 分离，SQLite 数据目录持久化，Docker Compose 生产编排

## 本地运行

要求 Node.js `22.5+`，因为项目使用 Node 内置 `node:sqlite`。

```sh
cp .env.example .env
```

运行前准备 `.env`，支付和 Telegram 登录都使用真实配置。先生成两个随机密钥：

```sh
PAYMENT_PROVIDER=dujiaopay
SESSION_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
CARD_ENCRYPTION_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
```

必须填写 `TELEGRAM_BOT_TOKEN`。DujiaoPay 的三项密钥可以在 `.env` 中同时填写，也可以先留空并在后台“支付渠道”页加密配置；未完整配置时买家端会禁止创建新订单。浏览器直接打开买家地址不会创建开发账号，必须从 Telegram Bot 的 Mini App 按钮进入。

也可以直接执行：

```sh
node scripts/generate-assets.js
node scripts/seed.js
npm test
npm run dev
```

开发服务：

- 买家端：`http://localhost:3000/`
- 管理后台：`http://localhost:3000/admin`
- 健康检查：`http://localhost:3000/api/health`

管理后台使用独立网页账号密码登录，不需要在 Telegram 内打开。首次启动前必须通过 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 初始化管理员账号，任何环境都不会生成默认密码。登录后可在“系统设置”中修改账号密码和配置 Telegram Bot Token，也可在“支付渠道”中配置或暂停 DujiaoPay。支付密钥使用服务端 AES-256-GCM 加密保存，GET 接口和页面不会回显明文；保存后 API 立即使用新配置，Worker 会在下一轮对账同步。首次账号落库并修改密码后，可从 `.env` 删除初始 `ADMIN_PASSWORD`。

## DujiaoPay 配置

生产环境可在 `.env` 预置以下变量，也可在首次登录后台后从“支付渠道”页保存相同配置。若采用后台配置，三项密钥会加密保存在 SQLite；不要同时在多个实例中使用不同的 `CARD_ENCRYPTION_KEY`。

```dotenv
NODE_ENV=production
APP_ORIGIN=https://mini.example.com
PAYMENT_PROVIDER=dujiaopay
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-12-character-password
TELEGRAM_BOT_TOKEN=...
DUJIAOPAY_BASE_URL=https://www.dujiaopay.com
DUJIAOPAY_KEY_ID=...
DUJIAOPAY_SECRET=...
DUJIAOPAY_WEBHOOK_SECRET=...
DUJIAOPAY_CHAIN=tron
DUJIAOPAY_TOKEN_ID=tron-usdt
SUPPORT_URL=https://t.me/your_support_bot
```

配置完成后先用官方 `/v1/whoami` 端点验证 HMAC 凭据与服务器时钟：

```sh
npm run payment:check
```

`SESSION_SECRET` 至少 32 个字符，`CARD_ENCRYPTION_KEY` 必须是 64 位十六进制字符。密钥只放在服务端环境变量，不要写入前端、数据库或 Git。

在 DujiaoPay 控制台将 Webhook 指向：

```text
https://mini.example.com/api/webhooks/dujiaopay
```

适配器发送 `DJP-Key-ID`、`DJP-Timestamp`、`DJP-Nonce`、`DJP-Signature`，并校验 `DJP-Webhook-ID` 去重。Webhook 收到支付事件后只入队发卡，实际发卡由 Worker 处理。

## Docker 部署

先准备生产 `.env` 和持久化目录：

```sh
mkdir -p data backups
chown -R 1000:1000 data backups
chmod 700 data backups
docker compose up -d --build

docker compose ps
docker compose logs -f xiuxian-worker
```

API 和 Worker 必须共享同一个 `./data`，不要只启动 API。反向代理负责 TLS，`APP_ORIGIN` 必须使用 HTTPS。只有当 API 端口仅能由可信反向代理访问，且代理会覆盖 `X-Forwarded-For` 时，才将 `TRUST_PROXY=true`；否则保持 `false`，防止客户端伪造 IP 绕过限流。上线前应限制服务器防火墙只暴露反向代理端口。

SQLite 使用 WAL 模式，不要在服务运行时直接复制数据库文件。使用内置在线备份命令生成一致性快照：

```sh
npm run backup
# Docker 部署
# docker compose exec xiuxian npm run backup
# 或指定备份目录
npm run backup -- /mnt/secure-backups
```

备份文件默认写入 `backups/`，权限为 `0600`。数据库结构由 `schema_migrations` 记录版本；部署新版本前先备份，应用启动时会按顺序执行尚未应用的迁移。

## API 关键路径

- `POST /api/auth/telegram`：买家 Telegram 登录
- `GET /api/catalog`：公开商品目录
- `POST /api/orders`：创建订单，需要 `Idempotency-Key`
- `GET /api/orders/:orderNo`：查看自己的订单
- `POST /api/orders/:orderNo/payment-session`：恢复支付会话
- `POST /api/webhooks/dujiaopay`：DujiaoPay 回调
- `POST /api/auth/admin/password`：独立管理员账号密码登录
- `GET /api/admin/settings`：查看非敏感 Telegram 与支付渠道配置状态
- `PATCH /api/admin/settings`：加密保存 Telegram Bot Token 或 DujiaoPay 支付配置
- `POST /api/admin/settings/test-payment`：验证已配置的 DujiaoPay 凭据
- `PATCH /api/admin/account`：修改管理员账号或密码
- `GET /api/admin/users`：买家资料、订单和消费统计
- `PATCH /api/admin/users/:id/status`：停用或恢复买家账号
- `GET /api/admin/dashboard`：运营数据
- `POST /api/admin/cards/import`：批量加密导入卡密
- `GET /api/admin/webhook-failures`：查看验签成功但业务处理失败的回调
- `POST /api/admin/orders/:orderNo/retry-fulfillment`：异常订单重新发卡

## 安全边界

- 卡密明文只在发放给已授权买家时解密，数据库只保存密文和指纹。
- 订单金额、币种、链和商户订单号由服务端核对，不能信任前端或回调中的展示字段。
- 支付回调按原始字节验签，重复 Webhook 和重复发卡任务均幂等。
- 生产环境强制 HTTPS；买家 Mini App 只接受 Telegram `initData` 和服务端验签，独立后台使用账号密码，运行时不提供开发登录。
- 失败 Webhook 会记录原因并返回非 2xx 触发渠道重试，可在后台订单页查看。
- Worker 会恢复超时锁，发卡前会禁用过期卡并从同 SKU 自动补卡。
- 商品删除使用归档，不物理删除历史关联数据。

## 目录

```text
apps/api       HTTP API 和静态文件服务
apps/miniapp   买家端 Mini App
apps/admin     管理后台
apps/worker    支付对账与自动发卡 Worker
packages/core  配置、SQLite、加密和订单领域服务
packages/payment 支付适配器接口与 DujiaoPay 实现
```
