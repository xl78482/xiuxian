# Release Process

XiuXian 使用严格递增的 `1.0.N` 版本号。远程仓库只保留 `main` 分支；所有代码、样式、文档、配置和运维改动都直接提交到 `main`，不建立长期功能分支。

## 版本规则

- 每次发布只将最后一位加 `1`，例如 `1.0.31 -> 1.0.32`。
- 不使用 `1.1.0`、`2.0.0` 等版本，也不得跳号。
- `scripts/check-version.js` 会根据最新 Git 标签校验唯一允许的下一个版本。

## 发布步骤

1. `git fetch --prune origin`，确认 `origin/main` 是最新且工作区干净。
2. 在 `main` 上更新 `package.json` 版本号，并同步 README、前端资源参数、运行时回退值和 Docker 镜像版本。
3. 在 `CHANGELOG.md` 顶部记录本次变更。
4. 运行 `npm run version:check`、串行测试 `node --test --test-concurrency=1 "test/*.test.js"`、语法检查和必要的 HTTP/浏览器验收。
5. 使用 `release: v1.0.N` 提交，并创建带说明的 `v1.0.N` 标签。
6. 先推送 `main`，再推送对应标签：

   ```sh
   git push origin main
   git push origin v1.0.N
   ```

7. 推送后确认远程 `main` 与标签指向正确提交，并删除已经合并的临时本地分支（远程只保留 `main`）。

## 清洁规则

- 不提交 `.env`、数据库、备份、API Key、Bot Token 或支付密钥。
- 不提交调试截图、临时 fixture、构建产物、压缩包或未使用资源。
- 新增文件必须有明确的运行时、测试、部署或文档用途；删除文件前先用 `git grep` 确认没有引用。
- 不修改已经发布标签指向的提交，不在标签后追加同版本提交。
