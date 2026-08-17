# Changelog

本项目遵循语义化版本。每次推送功能、修复、配置或文档更新到 GitHub，都必须先更新版本号并在此记录变更内容。

## [1.0.0] - 2026-08-17

### Added

- Telegram Mini App 买家端与 Telegram 管理员登录。
- 商品、分类、SKU、加密卡密库存、订单和自动发卡管理。
- DujiaoPay HMAC 建单、查单、取消与 Webhook v1 验签适配器。
- 支付幂等、库存预留、Webhook 去重、失败重试和异步发卡任务。
- 管理后台数据看板、商品与 SKU 编辑、卡密导入、订单和支付回调异常视图。
- SQLite 版本化迁移、WAL 在线备份和 DujiaoPay 凭据自检命令。
- Docker Compose API/Worker 编排、非 root 镜像与健康检查。
- 支付、Webhook、退款登记、过期卡替换和 Worker 恢复测试。
- 语义化版本、变更日志、发布校验、运行时版本展示和 `v1.0.0` 发布标签。

### Security

- AES-256-GCM 卡密加密和 HMAC 指纹去重。
- Telegram `initData` 服务端验签、会话签名、管理员白名单和接口限流。
- 支付金额、币种、链、代币、订单号及原始 Webhook body 校验。
- 生产 HTTPS、官方 DujiaoPay 域名、可信代理和静态资源 CSP 约束。

### Fixed

- 修复 Worker 崩溃后任务永久锁定、定时任务重叠和退出时中断任务。
- 修复预留卡过期后仍可能发放、迟到支付库存不足和幂等键串单。
- 修复后台隐藏表单默认展开、按钮图标尺寸、移动空状态和旧资源缓存。
- 修复 Node 22 实验性 SQLite 并行测试进程偶发崩溃，测试文件改为串行执行。
