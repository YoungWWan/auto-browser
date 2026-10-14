# Auto Browser v0.3.3

开源预览版的补丁更新。使用自己的 Agent，通过 MCP / CLI 在桌面原生 WebView 中操作网页，把人工录制、流程知识和可复用 JavaScript 工作包保存在本地。

## 本次更新

- 修复隐藏 WebView 已完成 DOM 初始化却一直显示加载中的问题，Jev 观察也会同步网页就绪状态。
- Jev 点击前按目标元素、局部上下文和表单状态检查变化，避免无关广告、文案或滚动变化反复消耗决策次数；目标替换、禁用、表单修改和页面跳转仍会阻止过期点击。
- 复用动作后的最新快照，减少重复观察；完成判断和滚动操作继续校验完整页面上下文。
- 增加隐藏网页就绪和点击状态检查的回归覆盖；密码状态只通过本地修订号参与检查，快照继续脱敏。

## 下载

| 系统    | 架构                  | 安装包                                    |
| ------- | --------------------- | ----------------------------------------- |
| macOS   | Apple Silicon / ARM64 | 文件名含 `aarch64-apple-darwin` 的 `.dmg` |
| macOS   | Intel / x64           | 文件名含 `x86_64-apple-darwin` 的 `.dmg`  |
| Windows | x64                   | `.exe` 安装程序或 `.msi`                  |
| Linux   | x64                   | `.AppImage`、`.deb` 或 `.rpm`             |

安装包包含原生 `auto-browser-agent` 和 Auto Browser Skill；安装后从「Agent 接入」复制配置指令。`SHA256SUMS.txt` 提供全部安装包的 SHA-256 校验值。

## 功能

- 业务空间管理、多网页切换和网站入口。
- 人工操作录制、原始事件与页面上下文回看。
- 由自己的 Agent 归档流程，或从零创建工作包。
- 固定版本的知识、JavaScript 脚本和录制来源；导入、导出与执行记录。
- MCP / CLI 接入指令，应用内提供真实二进制和 Skill 路径。
- 可选 Jev 网页操作委派，API Key 保存于系统凭据库。

## 预览版说明

这是早期预览版，安装包未配置发行者代码签名和 macOS 公证。macOS 与 Windows 可能显示发行者验证提示。Windows 依赖 WebView2 Runtime；Linux 依赖 WebKitGTK 4.1，Jev 密钥保存需要可用的 Secret Service。

三端通过各自 GitHub Actions 环境编译和自动测试；真实站点登录、不同桌面环境、Windows/Linux 原生交互仍需用户反馈。macOS 已完成核心原生验证。人工录制覆盖顶层 DOM；截图、可信原生键鼠、自动上传及跨域 iframe 操作尚未实现。Jev 尚未使用真实 API Key 完成线上推理验收。

发布采用 MIT 许可。
