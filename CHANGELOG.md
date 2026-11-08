# Changelog

## 0.2.0

- **修**：模型下拉框是空的。`llm.listProviders()` 只给 provider 元数据，模型要 `await llm.listModels(id)` 拿；改为异步取并加 60 秒缓存（`/models?refresh=1` 可强制刷新）。
- **改**：面板改用 DSH 主题变量（`--dsw-alias-*`），跟主界面同色同一套字阶；用户消息做成浅底块，助手回复按轻量 Markdown 渲染（代码块 / 列表 / 标题 / 引用 / 粗体 / 行内码 / 链接）。
- **加**：每条回复下面显示「输入 / 输出 / 缓存命中率」，顶栏显示这段对话的累计用量——数字直接来自每轮 `usage` 分片（`inputTokens` / `outputTokens` / `cacheReadTokens`），不是另算的。
- **加**：`/chat` 拒绝 `sec-fetch-site` 不是 same-origin 的请求（host 的 webServer 不做来源策略）。
- **修**：`finish` 分片按 `reason.kind` 判失败（原来是读 `kind`，永远读不到）。

## 0.1.0

- 首个版本：侧栏「闲聊」tab，直连 `ctx.llm.stream`，零工具、零会话上下文、历史只在内存。
