# 投稿到 awesome-dsh-plugin：现状与待办

条目内容见 [market-entry.yml](H:/dshX/dsh-clean-chat/docs/market-entry.yml)，PR 时**原样**放到
`data/plugins/ZIye1208__dsh-clean-chat.yml`（一个文件就是全部投稿，README 由 CI 生成，不要手改）。

## 硬性条件核对（2026-11-09 18:20 实测）

| # | 条件 | 状态 | 证据 |
|---|---|---|---|
| 1 | `package.json` 声明 `dsh.bundle` | ✅ | `dsh.bundle.patch = ./cordis.patch.yml`；patch 里 `id: clean-chat` / `name: dsh-clean-chat` 与包名一致 |
| 2 | 仓库有真实可用代码 | ✅ | `lib/` 约 2100 行；三套测试 76 + 89 + 24 项 |
| 3 | 仓库创建满 24 小时 | ✅ | 创建于 2026-11-08T16:03:30Z，2026-11-10 00:03（CST）达标，已合并 |
| 4 | 仓库带 `dsh-plugin` topic | ✅ | 已在 topics 里；同时清掉了已不属实的 `dsh-better-sidebar` |
| 5 | npm 包 `repository` 指回收录仓库 | ✅ | 已发 `dsh-clean-chat@1.0.0`，`repository` 指向本仓库；映射由 registry 自动采集，**条目 yml 里不要写 `npm:` 字段**（会被校验拒绝） |
| 6 | 图标是 GitHub 托管的位图 | ✅ | `assets/icon-180.png`（180×180 PNG，非 SVG） |
| 7 | 一 PR ≤ 3 条 | ✅ | 1 条 |

## 已对外发布

| 版本 | 日期 | GitHub Release | npm |
|---|---|---|---|
| `1.1.0` | 2026-11-17 | `v1.1.0`（tag 指向 `2fc7d31`） | `1.1.0`，tarball SHA1 `7cbb2590…` == registry `dist.shasum` |
| `1.0.0` | 2026-11-09 | `v1.0.0`（tag 指向 `c87ebf7`） | `1.0.0`，tarball SHA1 `4071194b…` == registry `dist.shasum` |

## 投稿状态：已合并 ✅

PR [#13740](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13740) 于 **2026-11-10 01:47（CST）** 合并（merge commit `9bae9bc`），条目落在 `data/plugins/ZIye1208__dsh-clean-chat.yml`（blob `0bcc07e4`），分类 `ui`。

市场条目的描述刻意只写「它做什么」（无上下文、只发一句系统提示、历史只在内存），不列 UI 能力清单——后续加功能不用回头改条目。

## 还差的前提

1. ~~仓库转公开~~ —— **2026-11-09 18:27 已转公开**（`gh repo edit --visibility public`）。
2. ~~等满 24 小时~~ —— 已过。

## 提交步骤（全程走 GitHub MCP，pwsh 里拿不到 token）

1. `create_branch`：fork（`ZIye1208/awesome-dsh-plugin`）建 `add-dsh-clean-chat`
2. `create_or_update_file`：`data/plugins/ZIye1208__dsh-clean-chat.yml`
3. `create_pull_request`：head `ZIye1208:add-dsh-clean-chat`，base `main`，body 用英文写：只新增 1 个文件、插件做什么、为何归 `ui`、代码形态（手写 JS、无构建步骤、无外部网络调用）
4. 等 CI 12–13 分钟，看 `check` 与 `Submission gate`

## 可选、可以合并后再补

- 截图：在本仓库放 `screenshots.json`（1–8 张相对路径，GitHub 托管），市场夜间构建自动读取，与收录 PR 完全解耦。**注意别把带私人系统提示词的截图放进去。**

## 提交记录

- 2026-11-10：PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13740 —— 只加 data/plugins/ZIye1208__dsh-clean-chat.yml 一个文件；check 与 Submission gate 均通过，mergeable=CLEAN。
- 2026-11-10 01:47：PR 合并（merge commit `9bae9bc`），条目进入市场。
- 2026-11-17：发布 1.1.0（排版对齐主界面 + 三处流式交互修复）。条目描述无需改动。
