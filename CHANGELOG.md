# Changelog

本项目的所有重要变更都记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

## [0.8.1] - 2026-11-09

### 修复

- **修掉 0.8.0 的启动崩溃**（`dsh-clean-chat: failed`，整次客户端 boot 中断）：
  - `inject` 补上 `slots`：cordis 的代理访问未声明服务会抛 `cannot get property "slots" without inject`，而 apply 抛异常 = boot 失败。
  - 正文席位改用 `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(...))`，等按 key 的席位就绪再注册（直接 `register` 会撞 unknown slot）。
  - `sidebarRightTabs` 不再写进模块级 `inject`（那是必达依赖，会让老宿主永远不激活），改为 `ctx.inject(['sidebarRightTabs'], …)` 按就绪回调。
  - apply 内部的挂载逻辑加兜底：任何运行期异常只 `console.error`，不再把宿主拖崩。
- 删掉 `better-sidebar` 退化路径：它与「模块级 inject 必达」互斥，留着是死代码。

### 测试

- client 60（改为**按 inject 声明守门**的假 ctx，且 `effect`/`inject` 会真的执行回调——0.8.0 就是靠假 ctx 白送服务才漏过的）+ unit 76 / render 11 全绿。
- 新增 `_tools/scripts/verify-client-activation.mjs` 激活演练：完整宿主 / 服务不就绪 / 宿主缺服务三种场景；已反向验证——拿 0.8.0 的旧 `client.js` 跑它会重现 `cannot get property "slots" without inject`。

## [0.7.2] - 2026-11-09

### 修复

- 只输入空白（空格/换行）时不再照常发起一次模型调用，改回 `400 没有可发送的用户消息`。
- 明确声明了非 JSON 类型（`text/plain`、表单等）的请求回 `415`，不再硬当 JSON 解析；没声明类型的老实调用照旧放行。

### 测试

- unit 76（+2）/ client 54 / render 11 全绿；另用真 socket + 桩 ctx 复验三件事：空白 `400`、`text/plain` `415`、正常 JSON `200` 且 `llm.stream` 只被调一次。

## [0.7.1] - 2026-11-09

### 修复

- 来源闸的「本机」判定从「回环地址」放宽到「本机任何网卡地址」：宿主若经本地代理转发，源地址可能是局域网 IP，之前会被误判成外部请求。
- 真 socket 验证（不是桩）：无任何头的 `GET /models` → `200`、`POST /chat` → `200` 且 SSE 正常；外站 `Origin` → `403`；回环 `Origin` 读设置 → `200`。

## [0.7.0] - 2026-11-09

### 修复

- **修**：来源闸彻底改判据——**桌面端面板的请求没有任何浏览器头部**（真机报错原文：`没有 sec-fetch-site（不是浏览器发的）`），跟 `curl` 完全一致，所以「靠头部区分面板和脚本」这条路走不通。0.6.0 挡在「必须 same-origin」、0.6.2 挡在「必须带 sec-fetch-site」，两次都把面板自己关在门外。
  现在只保留两条能真正生效的：
  - socket 必须来自回环地址（挡局域网与其它机器）；
  - `Origin` 若是 http(s) 外站则 `403`（挡网页 CSRF）。
- 客户端所有请求加上 `x-clean-chat: 1` 标记（当前判据不依赖它，留给宿主以后提供可验证凭据时用）。

### 文档

- README「安全模型」改成一张能直接看的表：局域网 ✅ 挡、网页 CSRF ✅ 挡、**本机脚本 ❌ 挡不住**——写清原因（请求形状与 curl 无差别）和补偿措施（模型白名单、限流、长度上限、错误脱敏），不再声称「只认同源」。
- README 补一段脚本调用示例。

### 测试

- unit 74：去掉「必须有 sec-fetch-site」相关断言，改成「回环 + 无任何头 → 放行」「回环 + 外站 Origin → 403」「非回环 socket → 403」。

## [0.6.2] - 2026-11-09

### 修复

- **修**：`cross-site` 不再一律拒绝。Electron 用自定义 scheme（`app://`、`file://`）承载的壳页面，浏览器会把它标成 `cross-site`——那是我们自己的宿主，不是攻击。现在只有 `Origin` 确实是 **http(s) 外站** 时才拒；`app://` / `file://` / `null` 一律放行。

> 0.6.1 已推送但你没重启过，本版是它的完整版，直接装 0.6.2 即可。

## [0.6.1] - 2026-11-09

### 修复

- **修**：0.6.0 的来源闸把宿主自己的面板挡在门外——桌面端页面发的不是 `same-origin`（实测被挡后模型列表空白、每次发送都回「跨站请求被拒绝」）。现在按「socket 是回环 + 带 `sec-fetch-site` + 不是 `cross-site` + `Origin` 主机是回环（若带）」判定：
  - `same-origin` / `same-site` / `none` 都放行（桌面端、`file://` 宿主页面都能过）；
  - `curl`、本机脚本、Node 客户端仍然拒绝（它们一个 `sec-fetch-site` 都没有）；
  - 真跨站页面（`cross-site` 且 `Origin` 是外站）拒绝；
  - 非回环 socket 拒绝（挡掉局域网访问）。
- **修**：403 响应里带上拒绝原因（`已拒绝（没有 sec-fetch-site）`），面板出错时截图就能定位，不用再猜。
- 宿主内存里保留最近 20 次拒绝的头部形状（`lastReject()` 可读），不落盘。

### 测试

- unit 74（+5：无 `sec-fetch-site`、`cross-site`、外站 `Origin`、非回环 socket、`none`/`same-site` 放行）。

## [0.6.0] - 2026-11-09

### 安全

- **修**：请求只服务回环地址。`Host` 头不是 `127.0.0.1` / `localhost` / `[::1]` 一律 `403`，挡掉 DNS rebinding 那种「把域名解析到本机」的玩法（此前只比对 `Origin === Host`，攻击者两边写同一个域名就能过）。
- **修**：上游报错不再原文回传给前端。适配器的失败对象可能带 URL、trace、甚至 `key=sk-...`；现在按错误码映射成人话（`MISSING_CREDENTIAL` → 「这个模型还没配置凭据」），未知码只回 `模型调用失败（CODE）`。

### 新增

- **限流**：每分钟最多 20 次对话请求、同时最多 2 个在途；超了回 `429`，提示「上一个回复还没结束」或「发得太快了」。此前本机任意进程都能无限刷模型。
- **消息条数上限** 200 条，超了 `413` 并说明条数。
- 面板顶部新增一行中性提示：存盘的模型已经不存在时（换机器、换提供方），自动切回默认模型并告诉用户，不再静默失败。

### 修复

- **修**：设置写盘不再每次按键都 `mkdir` + `write` + `rename`。防抖从 400ms 提到 800ms，内容没变就直接跳过（内容比较按序列化后的字符串）。
- **修**：外链补 `noopener`（此前只有 `noreferrer`）。
- **修**：SSE `delta` / `thought` 事件加类型守卫，上游给非字符串不再把 `content` 拼成 `undefined`。
- **修**：没装 `dsh-better-sidebar` 时不再静默什么都不做——`console.warn` 里直说面板不会出现、该装哪个插件。
- `MAX_SYSTEM_CHARS` 等上限收进 `lib/host/constants.js` 单点定义（此前 routes 与 settings 各写一份）。

### 文档

- README 安装段重写：新增「插件页添加」流程（设置 → 插件 → 添加，填本地目录 / `github:` / npm 名）、命令行两种写法、`bundles` 激活自查命令，以及 private 仓库的限制说明。

### 测试

- unit 69（+12）、client 54、render 11。新增：非回环 Host、消息条数上限、每分钟限流、并发在途上限、错误脱敏（不回传 URL 与 key）。

## [0.5.1] - 2026-11-09

### 安全

- **修**：`sec-fetch-site: none` 不再放行。此前 `isSameOrigin()` 允许 `none`，而 `curl`、本机脚本、浏览器扩展发的请求正好都是这个值——等于本机任意进程都能调 `/chat` 刷模型额度、读 `/settings` 拿走系统提示原文。现在只认 `same-origin`；没有该头时退回 `Origin`/`Referer` 与 `Host` 比对，两者都缺即 `403`。`/models`、`/settings` 读写同样加上这道闸。
- **修**：`/chat` 只接受 `llm.listModels` 里确实存在的 `provider` / `model` 组合（模型清单为空时不做此限制，避免 `listModels` 抖动导致不可用）。此前可点名任意模型，配合上一条就是账单放大器。

### 修复

- **修**：单条消息超 4 万字不再**静默截断**——实测 21 万字符的请求曾返回 `200` 并只发前 4 万，用户完全不知道内容被砍。现在回 `413` 并说明字数与上限；系统提示超 8000 字同样 `413`。
- **修**：请求体超限不再 `req.destroy()` 断开连接（前端只会看到 `fetch failed`）。上限从 512 KiB 提到 1 MiB（20 万中文字符按 UTF-8 约 600 KB，原来中文永远先撞字节闸、那个 413 中文提示形同虚设），超限时正常回 `413`。

### 测试

- 新增来源闸 7 项（无头 / `none` / `cross-site` / Origin 匹配 / Origin 不匹配 / 设置与模型路由）、长度超限 5 项、请求体超限 2 项、模型白名单 3 项。unit 57、client 54、render 11。

## [0.5.0] - 2026-11-09

### 修复

- 设置（系统提示 / provider / model）现在存在宿主磁盘上，重启不再恢复默认。此前只写 `localStorage`，而 DSH 的 GUI 端口每次启动都变、`localStorage` 按 origin 隔离，等于每重启一次就是一份新存储。

### 新增

- `GET /clean-chat/api/settings` 读盘、`POST /clean-chat/api/settings` 写盘；落盘位置 `~/.dsh/storages/clean-chat/settings.json`，只存 `system` / `provider` / `model` 三个字段，未知字段丢弃，长度按 8000 / 200 截断。
- 写盘用临时文件 + `rename` 原子替换；文件损坏或没权限时当空设置处理，不让面板白屏。
- 老版本升级上来的用户，宿主要是还没有记录，会把 `localStorage` 里的设置自动迁一次；`localStorage` 降级为纯缓存（宿主不可用时兜底）。
- 对话历史仍然不落盘——这是这个面板的本分，只有设置跨重启。

### 测试

- 新增 settings 路由 14 项（写盘 / 读回 / 部分更新 / 坏文件 / 跨站 / 405）+ 客户端持久化 10 项（hydrate、防抖 POST、迁移）。unit 41、client 54、render 11。

## [0.4.2] - 2026-11-09

### 新增

- 真实渲染测试 `test/render.test.mjs`——用真的 `react` + `react-dom/server` 渲染面板，devDependency 里加了 react / react-dom。结构测试用的假 React 不校验属性类型，`style` 传字符串这种错只能在真渲染时炸，测试里补上就再也不用靠用户重启试出来。
- `pnpm test` / `test:unit` / `test:client` / `test:render` 四个脚本。

### 测试

- 已验证这套测试能咬住上一版那个 bug：把 `style` 改回字符串，`render.test.mjs` 立刻 5 项失败；改回类名后全绿。

## [0.4.1] - 2026-11-09

### 修复

- 空状态那行提示把 CSS 写成字符串塞进 `style` 属性，React 直接抛 Minified React error #62（`style` 必须是对象映射）。改成 `.cc-empty-hint` 类，并在 `test/client.test.mjs` 里加了静态断言，禁止再出现字符串 style。

## [0.4.0] - 2026-11-09

### 变更

- 用量显示换成主界面同款——回复脚下是一个胶囊 `▤ 用量 2.0K`，点开弹层列出：提供方 / 模型、缓存命中（有命中才出现）、未缓存输入、缓存读取（有才出现）、缓存写入（有才出现）、输出。字段名与显示条件照抄 `@deepseek-ai/dsh-client-ui-chat` 的 `TurnUsagePanel`。

### 新增

- 弹层点外面或按 Esc 关闭；胶囊 `title` 里带一行紧凑文案（`246 输入 · 3.9K 输出 · 缓存命中 72.2%（640 tok）`）。
- 每轮记录实际路由（`start` 事件里的 provider/model），弹层第一行显示的就是它，跟用户选的模型可能不同（比如回落）。

### 其它

- 图标用 `▤` 文字符号代替主界面的 `IconDatabaseOutlineRegular`——`dsh-client-ui-primitives` 官方不建议插件 require。

## [0.3.1] - 2026-11-09

### 修复

- 命中率分母算错了。适配器的 `inputTokens` 是**未缓存**输入，`cacheReadTokens` 另算；原来用 `cacheRead / inputTokens`，真命中时会算出 260% 这种鬼数字。改成主界面口径：分母 = `totalTokens - outputTokens`（提示词总量）。
- 措辞。「该路由不返回缓存统计」是错的——pi-ai 适配器只在 `cacheRead > 0` 时写该字段（`...usage.cacheRead > 0 ? { cacheReadTokens } : {}`），没字段就是**这一轮真没命中**。改为「本轮无缓存命中」。

### 变更

- 数字格式对齐主界面 `formatTokens`（517 / 12.2K / 517K / 1.2M，M 级不再保留两位小数）；命中率沿用主界面规矩，剩一个 token 没命中就不许显示 100%（显示 99.9）。

### 新增

- 空状态补一句为什么这里命中率总是 0（默认只有一句系统提示，主界面的高命中来自几万 token 的系统提示 + 工具定义）。

## [0.3.0] - 2026-11-09

### 变更

- 用量行说实话。以前不管上游有没有缓存字段都印「命中 0%」——opencode 那类网关根本不返回 `cacheReadTokens`，看起来像「缓存全废」。现在区分三种：`缓存命中 640（72%）` / `缓存未命中` / `该路由不返回缓存统计`。顶栏累计同理。
- 布局对齐主对话。用户消息改成右对齐气泡（`color-mix` 取 7% 主文字色当底，窄至 86% 宽），助手消息不再有「助手」小标签、直接铺满宽度；思考过程收进 `<details>`，默认折叠，点「▸ 思考过程」才展开（以前是一坨灰字糊在回答上面）。
- 块间距 16 → 18px，列表内边距 14 → 16px。

## [0.2.1] - 2026-11-09

### 修复

- 第二轮对话必报 `Cannot read properties of undefined (reading 'replayState')`。assistant 历史消息必须带 `source: {kind:'model', provider, model}`——llm 服务的 `forAdapter()` 会对每条 assistant 消息读 `source.replayState` 判断能否复用上游回放状态，裸 `{role,content}` 就是 `undefined.replayState`。
- 输入框聚焦不再整圈变蓝（去掉 `:focus-within` 的 brand 描边），只在 hover 时换一档边框色。

## [0.2.0] - 2026-11-09

### 修复

- 模型下拉框是空的。`llm.listProviders()` 只给 provider 元数据，模型要 `await llm.listModels(id)` 拿；改为异步取并加 60 秒缓存（`/models?refresh=1` 可强制刷新）。
- `finish` 分片按 `reason.kind` 判失败（原来是读 `kind`，永远读不到）。

### 变更

- 面板改用 DSH 主题变量（`--dsw-alias-*`），跟主界面同色同一套字阶；用户消息做成浅底块，助手回复按轻量 Markdown 渲染（代码块 / 列表 / 标题 / 引用 / 粗体 / 行内码 / 链接）。

### 新增

- 每条回复下面显示「输入 / 输出 / 缓存命中率」，顶栏显示这段对话的累计用量——数字直接来自每轮 `usage` 分片（`inputTokens` / `outputTokens` / `cacheReadTokens`），不是另算的。
- `/chat` 拒绝 `sec-fetch-site` 不是 same-origin 的请求（host 的 webServer 不做来源策略）。

## [0.1.0] - 2026-11-09

### 新增

- 首个版本：侧栏「闲聊」tab，直连 `ctx.llm.stream`，零工具、零会话上下文、历史只在内存。

[Unreleased]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ZIye1208/dsh-clean-chat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ZIye1208/dsh-clean-chat/releases/tag/v0.1.0
