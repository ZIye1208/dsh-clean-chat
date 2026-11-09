# dsh-clean-chat

给 DSH 侧栏加一格**干净对话**：不给工具、不带会话上下文、不建会话文件——像网页版那样，只是问一句、答一句。

![tab](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue) ![npm](https://img.shields.io/npm/v/dsh-clean-chat) ![license](https://img.shields.io/badge/license-MIT-green)

## 它解决的问题

DSH 里的「侧边对话」和「创建分支」都会把主会话的历史带过去，还要带上整套工具（实测 minimal 预设起步仍约 16K token 的工具描述）。想随手问一句"这个函数名怎么念"，不该付出这个代价。

这一格是另一条路：**宿主直接发 `messages`，不带 `tools` 字段**。

| | 侧边对话（better-sidebar） | 创建分支 | 闲聊（本插件） |
|---|---|---|---|
| 带上主会话历史 | 全量原文（上行被压缩） | 全量原文 | ❌ 不带 |
| 带工具描述 | 是（继承预设） | 是 | ❌ 不带 |
| 写会话文件 | 是 | 是 | ❌ 不写 |
| 进会话列表 | 否 | 是 | ❌ 否 |
| 首轮 token 量级 | 十几 K 起 | 十几 K 起 | 一句话系统提示 + 你的问题 |

## 安装

**前置**：**不需要任何侧栏插件**。面板走 DSH 自带的右侧栏（`@deepseek-ai/dsh-client-ui-sidebar-right` 提供的 `ctx.sidebarRightTabs` 与 `sidebar.right.pane.tab` 席位）。装了 `dsh-better-sidebar` 也不冲突——它本身也是这套原生席位的消费者。

### 方式一：npm（推荐）

包已发布到 npm，装最新版：

```powershell
dsh plugin --profile desktop add dsh-clean-chat
```

钉住版本（推荐，发新版不会意外升级）：

```powershell
dsh plugin --profile desktop add dsh-clean-chat@1.0.0 --save-exact
```

### 方式二：插件页添加（不用记命令）

1. DSH 桌面端 → 左下角**设置** → **插件**
2. 右上角**添加**，在输入框里填下面任意一种标识：
   - npm：`dsh-clean-chat`
   - GitHub：`github:ZIye1208/dsh-clean-chat`
   - 本地目录：`H:/dshX/dsh-clean-chat`
3. 安装完成后**完全退出 DSH 再打开**（插件在启动时加载，热重载不生效）

> 从 npm 装的包是预构建产物，不需要跑构建脚本；从 GitHub 装会走源码，同样没有构建步骤（纯 JS，无打包器）。

> 前提：模型由宿主的 `llm` 服务提供，插件本身不带密钥——能用的模型就是你 DSH 里已经配好的那些。

### 方式三：命令行（与上面两条等价）

```powershell
# 从 npm
dsh plugin --profile desktop add dsh-clean-chat --save-exact

# 从本地目录（开发时改完源码立刻生效，桌面端装的是链接不是拷贝）
dsh plugin --profile desktop add H:/dshX/dsh-clean-chat

# 从 GitHub
dsh plugin --profile desktop add github:ZIye1208/dsh-clean-chat
```

装完同样要**完全退出 DSH 再打开**。

### 验证装上了

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Pattern "dsh-clean-chat"
```

`dependencies` 和 `dsh.profile.bundles` 两处都要出现——只进 `dependencies` 不进 `bundles` 的话插件不会激活。

## 用法

右侧栏 `+` 菜单 → **闲聊**。

- 左上角下拉选模型，按 provider 分组；默认「默认模型」（即设置里的默认模型）
- 「提示」改系统提示（默认 `You are a helpful assistant.`，留空则完全不带系统提示）
- 「清空」丢弃这段对话
- Enter 发送，Shift+Enter 换行；生成中可以「停止」
- 回复支持轻量 Markdown：代码块、列表、标题、引用、粗体、行内码、链接
- 每条回复下面有胶囊 `用量 2.0K`，点开看明细：提供方 / 模型、缓存命中、未缓存输入、缓存读取、缓存写入、输出（跟主界面的「本轮用量」同一套字段与口径）；顶栏是这段对话的累计
- 思考过程默认折叠，点「▸ 思考过程」展开

> 缓存这一项看路由：DeepSeek 官方路由（`deepseek-official` / `deepseek-account`）会返回 `cacheReadTokens`，网关型路由（如 `opencode-go`）**不返回**，面板会直说「该路由不返回缓存统计」，而不是谎报 0%。就算是官方路由，也只能命中**完全相同的长前缀**——同一句话问第二次才会看到命中。

历史**只在内存里**：关掉面板或重启 DSH 就没了。这是故意的——它不该变成第二个会话仓库。

**设置的存放位置**：系统提示 / 模型选择存在宿主磁盘 `~/.dsh/storages/clean-chat/settings.json`（只这三个字段），所以重启后还在。不存 `localStorage` 是有原因的：DSH 的 GUI 端口每次启动都变，而 `localStorage` 按 origin 隔离，靠它等于每次重启就换一份存储。`localStorage` 只当兜底缓存——宿主拿不到时用，恢复到宿主后自动迁回去。

## 安全模型

宿主路由挂在 `127.0.0.1:<随机端口>` 上，**没有登录态**——DSH 的 `webServer` 这一层不做来源/鉴权策略，所以闸门在插件自己手里。这里说清楚它到底挡住了什么：

| 攻击面 | 挡不挡 | 怎么做 |
|---|---|---|
| 局域网 / 其它机器 | ✅ 挡 | socket 必须来自回环地址（`127.0.0.1` / `::1`） |
| 你访问的网页偷打本机端口（CSRF） | ✅ 挡 | `Origin` 是 http(s) 外站一律 403 |
| 本机另一个程序 / 脚本 | ❌ 挡不住 | 见下 |

**为什么挡不住本机脚本**：桌面端的请求经过宿主一层转发，实测**没有 `sec-fetch-site`、没有 `Origin`、也没有别的可区分头部**——它跟 `curl` 发出来的东西一模一样。0.6.0 / 0.6.2 都试过从头部辨认，结果是把面板自己挡在门外（模型列表空白、每次发送 403）。与其继续猜，不如承认这条边界：

> 同机即同权。任何拿到你用户权限的程序本来就能读 `~/.dsh` 下的模型凭据和 `settings.json`，插件挡不住它，也不假装挡得住。

对应的补偿措施：

- `/chat` 只接受**确实存在**的 `provider` / `model` 组合（来自 `llm.listModels`），不接受点名任意模型刷账单；
- 每分钟最多 20 次、同时最多 2 个在途，超了 `429`；
- 单条 4 万字、总量 20 万字、200 条消息、请求体 1 MiB，超了 `413` 并说明原因，**不静默截断**；
- 上游报错只回人话 + 错误码，不回传原文（原文可能带 URL / trace / key）。

被 403 时会带原因（例：`已拒绝（Origin 主机不是回环：evil.example.com）`），截图就能定位。

## 它不带什么

- 不带工具：模型不能读文件、不能搜索、不能执行命令（要它看东西，自己粘贴进去）。
- 不带会话上下文：它不知道你在主对话里聊了什么。
- 不写会话日志：会话列表、上下文报表、bili 的折叠账本都不会多出一条。

## 兼容性

- DSH `0.2.2-rc.1`（桌面端）实测可用；要求宿主暴露 `webServer` 与 `llm` 服务。
- 面板走宿主原生右侧栏（`ctx.sidebarRightTabs.register` + `ctx.slots.inject('sidebar.right.pane.tab', …)`）；宿主没有该服务时只警告、不注册界面（host 路由仍可访问）。

## 开发

无构建步骤：`lib/client.js` 是手写的 `__ModuleLoader__` 工厂，`lib/host/*` 是纯 ESM。

```powershell
pnpm install              # 只为测试装 react / react-dom
pnpm test                 # 三套测试一起跑
node --check lib/client.js
```

| 测试 | 跑什么 |
|---|---|
| `test/unit.test.mjs` | 假 ctx/req/res 跑路由：SSE 事件序列、超时/报错、没有 tools 字段、assistant 历史必须带 source |
| `test/client.test.mjs` | 假 React 验结构：模块加载、tab 注册、纯函数（用量折算 / markdown / 数字格式）、禁止字符串 style |
| `test/render.test.mjs` | **真 React 渲染**：面板整屏、用量胶囊、Markdown——属性类型错误只有真渲染才会炸 |

## 接口（给自己的脚本用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/clean-chat/api/ping` | 探活 |
| GET | `/clean-chat/api/models` | 可用 provider/model 列表 + 当前默认 |
| GET | `/clean-chat/api/settings` | 读存盘的设置（文件不存在返回 `{}`） |
| POST | `/clean-chat/api/settings` | body `{system?, provider?, model?}`，合并写盘，返回完整设置 |
| POST | `/clean-chat/api/chat` | body `{system?, provider?, model?, messages:[{role,content}]}`，返回 SSE：`start` / `thought` / `delta` / `usage` / `done` / `error` |

脚本调用示例（回环地址就够，不需要任何鉴权头——见「安全模型」）：

```powershell
$body = @{ messages = @(@{ role = 'user'; content = '你好' }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod "http://127.0.0.1:<端口>/clean-chat/api/chat" -Method Post `
  -ContentType 'application/json; charset=utf-8' -Body $body
```

## License

MIT
