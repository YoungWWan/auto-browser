# Auto Browser

Tauri 2 跨平台桌面应用：在原生 WebView 中打开网站，让用户自己的 Agent 通过 MCP / CLI / Skill 读取流程、操作网页并保存可复用工作包。无需 Chrome 扩展，不绑定模型供应商。

首个公开版本为 **v0.3.1 预览版**，采用 [MIT 许可](LICENSE)。已实现业务空间、人工录制、两种归档状态、Agent 归档与从零生成、工作包版本及 WebView 内 JS 执行。「Agent 接入」提供可复制的一句话，让用户自己的 Agent 完成配置和连接检查。通过 GitHub Actions 构建 macOS、Windows、Linux 安装包；macOS 已完成核心原生验证，Windows/Linux 的真实站点与桌面交互仍需运行验收。

## 下载与平台

从 [Releases](https://github.com/YoungWWan/auto-browser/releases) 下载对应安装包，功能和限制见 [发布说明](RELEASE_NOTES.md)。

| 系统    | 架构                 | 格式                        |
| ------- | -------------------- | --------------------------- |
| macOS   | Apple Silicon、Intel | `.dmg`                      |
| Windows | x64                  | `.exe`、`.msi`              |
| Linux   | x64                  | `.AppImage`、`.deb`、`.rpm` |

安装包包含原生 MCP / CLI Agent 与 Skill。预览版尚未配置发行者代码签名或 macOS 公证。Windows 需要 WebView2 Runtime；Linux 需要 WebKitGTK 4.1，Jev 密钥保存需要可用的 Secret Service。

## 使用路径

1. 点击侧栏顶部的「业务空间」，选择「新建业务空间」，例如「客户管理」。网站入口可以稍后添加；创建后直接进入空间。菜单中的「管理业务空间」用于修改名称、说明和网站入口。
2. 在该空间打开网页，点击「开始录制」，命名流程，然后实际操作网页。结束后生成未归档流程，原始事件和页面上下文可以回看。
3. 在流程详情复制归档任务给自己的 Agent。Agent 读取原始记录，总结目的、输入、通用步骤与判断条件，提交归档说明和可选 JS 脚本。归档由自己的 Agent 提交。
4. Agent 根据当前网页判断何时调用哪个脚本，指定 WebView、归档版本和本次参数。调用完成后继续观察，验证实际业务结果。

网页列表和流程库跟随侧栏选择的业务空间；切换时恢复空间上次选中的网页，已有网页保留归属。管理页浏览或编辑其他空间不会切换工作区。未分配的旧网页在「全部业务空间」中通过显式操作分配，录制不自动改变网页归属。

Agent 也能从零创建已归档工作包，无需用户录制。归档后原始记录继续保留；归档、脚本返回和业务验证分别判断。流程库可临时查看「全部空间」，不改变当前工作空间；默认 API 能发现所有空间的两种状态。产品界面统一称「业务空间」，接口仍保留 `Domain`、`domainId` 和 `domain_*`，兼容已有 Agent 和数据。

「旧资料与回放」保留原有 Markdown Guide、固定 JSON 动作脚本和历史记录，没有自动转换或认定归档。升级时旧数据库保留一份 `store.before-domain-model.json` 备份。

## 启动与打包

需要 Node.js 24+、Rust stable 和 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run desktop
# npm run dev 仅预览管理界面，不提供原生网页操作
npm run desktop:build
# macOS 分架构构建，先用 rustup target add 安装目标
npm run desktop:build -- --target aarch64-apple-darwin --bundles dmg
npm run desktop:build -- --target x86_64-apple-darwin --bundles dmg
```

默认生成 release 安装包，位于 `src-tauri/target/release/bundle/`；显式使用 `--target` 时位于 `src-tauri/target/<target>/release/bundle/`。调试构建可加 `--debug`。`desktop:build` 会先编译并打包同一架构的 Agent 二进制；直接运行 `tauri build` 不会准备 Agent。

主分支与 PR 自动执行三端检查；推送 `v*` 标签后执行四个构建目标，全部通过后发布 GitHub 预览版和 `SHA256SUMS.txt`。发布前运行 `npm run check:version`，确保 npm、Cargo、Tauri 和标签版本一致。云端运行器临时不可用时，可在 Actions → Release → Run workflow 选择 `main` 并填写已有版本标签重试；构建仍读取该标签的源码。macOS CI 使用 `macos-15-intel`，通过 Rust 目标分别生成 Intel 与 Apple Silicon 安装包。

## 接入自己的 Agent

打开侧栏「Agent 接入」，点击「复制接入指令」，将这句话发给自己的 Agent。指令包含当前应用的 Skill 绝对路径、原生 Agent 二进制和连接文件路径，要求 Agent 按其客户端规范安装整个 Skill 目录、合并 MCP 配置并保留已有服务，再只读查询应用、业务空间、网页与流程验证连接。当前会话不能加载新 MCP 时先使用同一连接的 CLI 检查，由 Agent 告知是否需要重启客户端。

需要手动配置时展开「手动配置 MCP、Skill 或 CLI」。应用内配置使用本机真实路径；开发二进制为 `src-tauri/target/debug/auto-browser-agent`（Windows 带 `.exe`）。示例：

```json
{
  "mcpServers": {
    "auto-browser": {
      "command": "/absolute/path/to/auto-browser-agent",
      "args": ["mcp"],
      "env": {
        "AUTO_BROWSER_CONNECTION": "/absolute/app/data/directory/agent.json"
      }
    }
  }
}
```

将 `agent-skills/auto-browser` 复制到 Agent 支持的 skills 目录。Skill 描述使用方法，实际连接需要 MCP 工具或调用 CLI。CLI 也要使用相同的 `AUTO_BROWSER_CONNECTION` 环境变量，以连接当前应用实例。复制接入指令不会执行配置或网页操作，令牌不进入指令；应用保持运行，最终连接结果由外部 Agent 检查。

```sh
src-tauri/target/debug/auto-browser-agent status
src-tauri/target/debug/auto-browser-agent tools
src-tauri/target/debug/auto-browser-agent call domain_list '{}'
src-tauri/target/debug/auto-browser-agent call flow_list '{}'
src-tauri/target/debug/auto-browser-agent call browser_list '{}'
```

主要工具：

| 用途                       | 工具                                                     |
| -------------------------- | -------------------------------------------------------- |
| 业务空间                   | `domain_list/get/create/update`                          |
| 打开并绑定网页             | `browser_open`, `browser_bind_domain`, `browser_list`    |
| 观察与操作                 | `browser_snapshot`, `browser_action`, `browser_navigate` |
| 原始录制                   | `recording_start/stop/list/get/status`                   |
| 全部流程发现与读取         | `flow_list`, `flow_get`                                  |
| 外部 Agent 归档 / 从零生成 | `flow_archive`, `flow_create_archived`                   |
| 包内脚本                   | `flow_script_get`, `flow_script_run`                     |
| JS 执行记录与结果          | `script_run_list`, `script_run_get`                      |
| 完整包导入导出             | `flow_export`, `flow_import`                             |

`recording_get` 和 `flow_list` 支持分页，跟随 `nextOffset` 读取完整资料。工具参数以 `tools` 输出及 [Skill](agent-skills/auto-browser/SKILL.md) 为准。

## 可选 Jev 委派

在「配置 → Jev 快速网页操作」选择 TypeSafe 或 OpenRouter，保存 API Key，并明确启用允许发送网页文字的业务空间。密钥保存在系统凭据库，不写入业务数据库、接入指令或 MCP 返回值。未启用空间保持原有 Agent 操作方式。

外部 Agent 通过 `browser_delegate_start` 委派指定 WebView 的子目标，使用 `browser_delegate_get/list/stop` 查询或停止。Jev 只在应用列出的按钮、链接和滚动候选中选下一步；填写信息、调用工作包 JS、归档和最终核查仍由你的 Agent 完成。任务有网站、步数、时间和置信度限制；完成状态为 `needs_verification`，需要重新观察确认。配置保存会停止运行中的委派。

Jev 默认关闭，只对用户明确启用的业务空间开放委派。当前没有使用真实 API Key 完成线上推理验收，已验证协议适配、模拟决策循环和原生应用配置。

## JS 工作包约定

一个归档版本同时固定知识、脚本和来源。每个脚本包含 `id`、`name`、`content`、输入定义和调用说明。`content` 是 **async 函数体**，可使用 `document`、`inputs`、`signal`，支持 `await`，通过 `return` 返回 JSON 数据，不写模块导出或外围函数声明。

```javascript
if (signal.aborted) throw new Error("已取消");
const field = document.querySelector("#name");
if (!field) throw new Error("字段不存在");
field.value = inputs.name;
field.dispatchEvent(new Event("input", { bubbles: true }));
return { name: field.value };
```

`flow_script_run` 固定 `flowId/version/scriptId/sessionId`，目标网页须绑定同一业务空间。返回 `scriptRunId`，查询 `script_run_get` 取得结果。超时发送 AbortSignal；未返回的 Promise 会继续占用网页，直到返回、重新加载或关闭页面。`uncertain` 需要核查，不自动重试。JS 函数返回成功不代表业务成功。

[客户演示归档内容](examples/customer-flow-create.json) 包含填写和保存两个脚本。创建时补充 `domainId`；对录制归档时使用 `flowId`、最新 `expectedRevision` 和来源录制 ID。独立脚本源码在 `examples/flow-scripts/`。这些示例仅适用于应用自带 `auto-browser://demo`。

完整导出为一个 JSON 资产包，含 Flow、全部归档版本、多个 JS 脚本以及原始录制。界面使用系统保存对话框导出、文件选择器导入；导入重新分配本地 ID，保留包内来源关联，不执行脚本。

## 验证

```sh
npx playwright install chromium
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run build
npm run test:ui:spaces
npm run test:ui:jev
# Jev 原生检查仅在独立预览版运行，指定 AUTO_BROWSER_CONNECTION 后执行 npm run test:jev:native
# 启动桌面应用后进行实际 WebView 与 MCP 验证
npm run test:e2e
npm run test:flows
```

`test:ui:spaces` 使用隔离 IPC 夹具回归空间切换、资料编辑、网页归属、录制入口及接入指令复制，不读写实际业务数据。`test:e2e` 回归旧脚本及 Guide；`test:flows` 通过官方 MCP SDK 归档工作包，验证原生录制、页面跳转继续采集、异步 JS、参数、权限、来源、导入导出和超时占用。原生测试只使用本地练习页面，并在命名为「MCP 工作包验证」的业务空间中留下测试资产与执行记录。

当前人工录制覆盖顶层 DOM；页面上下文有长度和字段数量上限，单份录制最多 10000 条事件。iframe、Shadow DOM、原生弹窗和上传文件内容尚未采集。截图、可信原生键鼠及自动文件上传未实现。实际登录持久化、复杂站点和 Windows/Linux 原生行为仍需验证。

## 项目结构

- `src/`：React 管理界面与 Agent 接入。
- `src-tauri/src/`：原生 WebView、本地存储、MCP / CLI 服务、录制与脚本执行。
- `agent-skills/auto-browser/`：随应用分发的 Agent Skill。
- `examples/`：本地练习页面配套流程和脚本。
- `tests/`、`scripts/`：回归检查与跨平台打包工具。
- `.github/workflows/`：三端 CI 和版本发布。

开发设计资料 `docs/` 保留在本地，当前不进入公开仓库。问题反馈请附操作系统、应用版本、复现步骤和脱敏后的错误信息。
