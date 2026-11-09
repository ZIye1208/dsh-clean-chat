# 投稿到 awesome-dsh-plugin：现状与待办

条目内容见 [market-entry.yml](H:/dshX/dsh-clean-chat/docs/market-entry.yml)，PR 时**原样**放到
`data/plugins/ZIye1208__dsh-clean-chat.yml`（一个文件就是全部投稿，README 由 CI 生成，不要手改）。

## 硬性条件核对（2026-11-09 18:20 实测）

| # | 条件 | 状态 | 证据 |
|---|---|---|---|
| 1 | `package.json` 声明 `dsh.bundle` | ✅ | `dsh.bundle.patch = ./cordis.patch.yml`；patch 里 `id: clean-chat` / `name: dsh-clean-chat` 与包名一致 |
| 2 | 仓库有真实可用代码 | ✅ | `lib/` 1711 行 / 66 KB，三套测试 76 + 60 + 11 项 |
| 3 | 仓库创建满 24 小时 | ⏳ | 创建于 2026-11-08T16:03:30Z，**2026-11-10 00:03（CST）** 达标 |
| 4 | 仓库带 `dsh-plugin` topic | ✅ | 已在 topics 里；同时清掉了已不属实的 `dsh-better-sidebar` |
| 5 | npm 包 `repository` 指回收录仓库 | — | 不发 npm；`package.json` 的 `repository` 已指向本仓库 |
| 6 | 图标是 GitHub 托管的位图 | ✅ | `assets/icon-180.png`（180×180 PNG，非 SVG） |
| 7 | 一 PR ≤ 3 条 | ✅ | 1 条 |

## 还差的前提

1. ~~仓库转公开~~ —— **2026-11-09 18:27 已转公开**（`gh repo edit --visibility public`）。`raw.githubusercontent.com/.../package.json` 与图标 URL 均实测 200。
2. **等满 24 小时**：未满时 gate 会报「0.x days old」，属于快照结论——到点会自动重跑，不用推空提交。

## 提交步骤（全程走 GitHub MCP，pwsh 里拿不到 token）

1. `create_branch`：fork（`ZIye1208/awesome-dsh-plugin`）建 `add-dsh-clean-chat`
2. `create_or_update_file`：`data/plugins/ZIye1208__dsh-clean-chat.yml`
3. `create_pull_request`：head `ZIye1208:add-dsh-clean-chat`，base `main`，body 用英文写：只新增 1 个文件、插件做什么、为何归 `ui`、代码形态（手写 JS、无构建步骤、无外部网络调用）
4. 等 CI 12–13 分钟，看 `check` 与 `Submission gate`

## 可选、可以合并后再补

- 截图：在本仓库放 `screenshots.json`（1–8 张相对路径，GitHub 托管），市场夜间构建自动读取，与收录 PR 完全解耦。**注意别把带私人系统提示词的截图放进去。**
