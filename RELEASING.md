# Release Process

XiuXian 当前版本为 `1.0.0`。所有推送到 GitHub 的项目更新都必须使用新版本号，不能在同一版本下追加提交。

## 版本规则

采用 `MAJOR.MINOR.PATCH` 语义化版本：

- `PATCH`：兼容的修复、文档、配置、样式和运维改进，例如 `1.0.0 -> 1.0.1`。
- `MINOR`：兼容的新功能或新支付适配器，例如 `1.0.1 -> 1.1.0`。
- `MAJOR`：不兼容的 API、数据结构或部署变更，例如 `1.1.0 -> 2.0.0`。

即使只更新文档或部署配置，推送到 GitHub 时也至少增加 `PATCH`。

## 每次发布必须完成

1. 确认远程 `main` 没有未合并更新。
2. 修改 `package.json` 中的 `version`。
3. 同步 README 的“当前版本”。
4. 在 `CHANGELOG.md` 顶部新增该版本及具体更新内容。
5. 运行 `npm run version:check`、`npm test` 和必要的 HTTP/浏览器验收。
6. 使用包含版本号的提交说明，例如 `release: v1.0.1`。
7. 创建带说明的 Git 标签：`git tag -a v1.0.1 -m "XiuXian v1.0.1"`。
8. 推送分支和标签：`git push origin main && git push origin v1.0.1`。
9. 交付回复必须明确标注：版本号、更新内容、提交哈希、标签和测试结果。

## 禁止事项

- 不得修改已经发布标签指向的提交。
- 不得在未更新版本号和变更日志时推送代码。
- 不得将 `.env`、数据库、备份、API Key、Bot Token 或支付密钥提交到仓库。
