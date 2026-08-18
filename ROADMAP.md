# Roadmap

## 上线收款前（P0）

- 在 BotFather 配置正式 Bot、Mini App HTTPS URL 和菜单入口。
- 填入真实 DujiaoPay 凭据，执行 `npm run payment:check`，完成一笔最小金额真实支付、Webhook 重投和订单对账演练。
- 部署 TLS 反向代理、防火墙和可信代理设置；只有代理覆盖 `X-Forwarded-For` 时启用 `TRUST_PROXY=true`。
- 设置每日在线备份、异机保存与恢复演练；目前已有备份工具，但没有外部调度和告警。
- 建立 `SESSION_SECRET`、卡密加密密钥、Telegram Token 和支付密钥的轮换流程。
- 添加 GitHub Actions：运行语法检查、测试和 Docker 构建；当前执行环境会自动移除 `.github/workflows`，需在仓库侧补建。
- 接入错误与可用性告警，至少覆盖 API 健康、Worker 停止、发卡失败、Webhook 死信和低库存。

## 运营能力（P1）

- 商品图片上传、裁剪和对象存储；目前只接受 `/assets/` 本地路径。
- 卡密批次详情、批次停用、单卡禁用、过期库存清理和导入结果下载。
- 订单搜索、时间筛选、分页和详情侧栏；状态筛选已完成，后台目前只显示最近 200 条。
- 明确的商户取消订单与人工退款登记流程；`refund.recorded` 只按 DujiaoPay 官方语义记录，不代表平台已执行退款。
- 发卡完成 Telegram 通知、低库存通知和异常订单通知。
- 审计日志后台页面、管理员操作二次确认和多角色权限。
- 买家端订单分页、兑换说明详情和售后工单关联。

## 扩展与规模（P2）

- EPUSDT 与其他易支付适配器。
- 多币种、多链和付款人自选链币。
- 多实例部署时迁移到 PostgreSQL，并使用 Redis/独立队列处理分布式限流和任务锁。
- Prometheus/OpenTelemetry 指标、集中式结构化日志和错误追踪。
- 国际化、优惠码、套餐组合、库存预警阈值和销售报表导出。

## 当前边界

当前版本适合单机、单 Worker 的首期 MVP。支付签名、Webhook 幂等、库存预留、卡密加密、发卡恢复、数据库迁移和在线备份均已有实现，但在没有真实 DujiaoPay 凭据和正式 Telegram Bot 的情况下，不能宣称已完成生产支付验收。
