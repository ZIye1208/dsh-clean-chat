# Changelog

## 0.3.0

- **改**：用量行说实话。以前不管上游有没有缓存字段都印「命中 0%」——opencode 那类网关根本不返回 `cacheReadTokens`，看起来像「缓存全废」。现在区分三种：`缓存命中 640（72%）` / `缓存未命中` / `该路由不返回缓存统计`。顶栏累计同理。
- **改**：布局对齐主对话。用户消息改成右对齐气泡（`color-mix` 取 7% 主文字色当底，窄至 86% 宽），助手消息不再有「助手」小标签、直接铺满宽度；思考过程收进 `<details>`，默认折叠，点「▸ 思考过程」才展开（以前是一坨灰字糊在回答上面）。
- **改**：块间距 16 → 18px，列表内边距 14 → 16px。

## 0.2.1

- **修**：第二轮对话必报 `Cannot read properties of undefined (reading 'replayState')`。assistant 历史消息必须带 `source: {kind:'model', provider, model}`——llm 服务的 `forAdapter()` 会对每条 assistant 消息读 `source.replayState` 判断能否复用上游回放状态，裸 `{role,content}` 就是 `undefined.replayState`。
- **改**：输入框聚焦不再整圈变蓝（去掉 `:focus-within` 的 brand 描边），只在 hover 时换一档边框色。

## 0.2.0

- **修**：模型下拉框是空的。`llm.listProviders()` 只给 provider 元数据，模型要 `await llm.listModels(id)` 拿；改为异步取并加 60 秒缓存（`/models?refresh=1` 可强制刷新）。
- **改**：面板改用 DSH 主题变量（`--dsw-alias-*`），跟主界面同色同一套字阶；用户消息做成浅底块，助手回复按轻量 Markdown 渲染（代码块 / 列表 / 标题 / 引用 / 粗体 / 行内码 / 链接）。
- **加**：每条回复下面显示「输入 / 输出 / 缓存命中率」，顶栏显示这段对话的累计用量——数字直接来自每轮 `usage` 分片（`inputTokens` / `outputTokens` / `cacheReadTokens`），不是另算的。
- **加**：`/chat` 拒绝 `sec-fetch-site` 不是 same-origin 的请求（host 的 webServer 不做来源策略）。
- **修**：`finish` 分片按 `reason.kind` 判失败（原来是读 `kind`，永远读不到）。

## 0.1.0

- 首个版本：侧栏「闲聊」tab，直连 `ctx.llm.stream`，零工具、零会话上下文、历史只在内存。
