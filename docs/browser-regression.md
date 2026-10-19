# 固定浏览器回归

使用 Node.js 24，先执行 `npm ci`、`npm run prisma:generate`。浏览器工具是锁定版本的开发依赖 `playwright-core`，不进入生产依赖。

```sh
npx playwright-core install chromium
npm run test:all
```

Linux CI 使用 `npx playwright-core install --with-deps chromium` 安装浏览器及系统依赖。本机未安装测试 Chromium 时可使用已安装的 Chrome，也可通过环境变量 `BROWSER_EXECUTABLE` 指定浏览器可执行文件。

- `npm test`：在临时数据库和素材目录中运行全部单元/服务回归测试，即使本机配置了正式数据路径，也不会使用它们。
- `npm run test:browser`：运行 `tests/browser/regression.cjs`，自动启动独立 Next 服务、本地图像模拟服务和无界面浏览器。
- `npm run test:all`：依次运行单元/服务测试、类型检查和浏览器完整回归。

浏览器测试使用随机端口、独立 SQLite/素材目录、唯一构建缓存及专用临时 tsconfig，不占用 3000 端口、不改主 tsconfig、不覆盖 `.next`。结束后关闭测试子进程并清理本次创建的临时数据，日志、结果和截图留在 `test-output/browser-regression/`。不会读取真实模型 Key 或调用付费模型。

固定覆盖：

1. IndexedDB v1 草稿迁移；原图只写一次，30 次进度更新仅写小记录；存储失败回滚与草稿清理。
2. 单张和三张翻译：提交跳转、创建/上传响应丢失后的恢复、进行中与部分完成时刷新、结果预览和原图对照。
3. 完成停止轮询、切回页面单次同步、作品列表不重复、结果图专用 WebP 缩略图。
4. 数据管理备份、回收站还原、缺失作品恢复、无效图片拒绝、恢复后原图与结果完整。
5. 补充信息统一单位校验、旧错误清除、关闭后轮询不重新弹出、逐题答案保留、提交失败保留输入，以及不合格候选的具体原因展示。

PR 和主分支推送通过 `.github/workflows/regression.yml` 自动执行完整回归；桌面发布测试同样包含浏览器验收。失败时 CI 上传截图和日志。源码已接入 CI，本地测试不等于已在远程 CI 成功运行。
