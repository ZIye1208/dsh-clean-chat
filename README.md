# dsh-clean-chat

给 DSH 侧栏加一格**干净对话**：不给工具、不带会话上下文、不建会话文件——像网页版那样，只是问一句、答一句。

![tab](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue) ![license](https://img.shields.io/badge/license-MIT-green)

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

**从本地目录**（开发时）：

```powershell
dsh plugin --profile desktop add H:\path\to\dsh-clean-chat
```

**从 GitHub**：

```powershell
dsh plugin --profile desktop add github:ZIye1208/dsh-clean-chat
```

装完**完全退出 DSH 再打开**（插件在启动时加载）。

依赖：已安装 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar)（本插件把面板注册进它的右侧栏）。

## 用法

右侧栏 `+` 菜单 → **闲聊**。

- 右上角下拉选模型，默认「跟随默认模型」（即设置里的默认模型）
- 「提示」改系统提示（默认 `You are a helpful assistant.`，留空则完全不带系统提示）
- 「清空」丢弃这段对话
- Enter 发送，Shift+Enter 换行；生成中可以「停止」

历史**只在内存里**：关掉面板或重启 DSH 就没了。这是故意的——它不该变成第二个会话仓库。

## 它不带什么

- 不带工具：模型不能读文件、不能搜索、不能执行命令（要它看东西，自己粘贴进去）。
- 不带会话上下文：它不知道你在主对话里聊了什么。
- 不写会话日志：会话列表、上下文报表、bili 的折叠账本都不会多出一条。

## 兼容性

- DSH `0.2.2-rc.1`（桌面端）实测可用；要求宿主暴露 `webServer` 与 `llm` 服务。
- 面板依赖 `ctx.betterSidebar.registerTab`；没装 better-sidebar 时插件不注册任何界面（host 路由仍可访问）。

## 开发

无构建步骤：`lib/client.js` 是手写的 `__ModuleLoader__` 工厂，`lib/host/*` 是纯 ESM。

```powershell
node test/unit.test.mjs   # 假 ctx/req/res 跑一遍路由，不碰真模型
node --check lib/client.js
```

## 接口（给自己的脚本用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/clean-chat/api/ping` | 探活 |
| GET | `/clean-chat/api/models` | 可用 provider/model 列表 + 当前默认 |
| POST | `/clean-chat/api/chat` | body `{system?, provider?, model?, messages:[{role,content}]}`，返回 SSE：`start` / `thought` / `delta` / `usage` / `done` / `error` |

## License

MIT
