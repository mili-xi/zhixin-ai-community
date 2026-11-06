# 智心AI Desktop

智心AI Desktop 是 Web 工作台的桌面运行容器，同时承载免费媒体授权、浏览器自动化发布和桌面命令监听。Web 与桌面端共用 FastAPI、PostgreSQL 和 Redis 中的业务数据，桌面端不维护另一套文章或发布记录。

## 运行结构

- Tauri 壳加载 `http://127.0.0.1:3001/dashboard`，展示与 Web 端一致的工作台。
- 桌面应用启动后自动拉起内置 Node Agent，并持续轮询桌面命令。
- Agent 使用 Playwright 和平台专用 adapter 完成授权、Cookie 采集、文章排版、图片上传和发布结果回写。
- 未实现或未知平台采用 fail-closed 行为，不会伪造登录态、Cookie 或发布 URL。
- 应用使用单实例锁，同一时间只允许一个智心AI桌面端和一个受管 Agent 运行。

## 前置服务

桌面端依赖项目后端和 Web 服务。Docker 部署时先启动：

```powershell
docker compose up -d
```

默认地址：

```text
Web: http://127.0.0.1:3001
API: http://127.0.0.1:8000
```

如 API 地址不同，可通过环境变量覆盖：

```powershell
$env:ZHIXIN_API_BASE_URL="http://127.0.0.1:8000"
```

## 正式 Release

正式构建会把以下资源放入 Tauri release：

- Node.js runtime。
- Desktop Agent 源码及其运行依赖。
- Playwright runtime。
- Chromium 浏览器。

因此正式 release 不依赖用户机器预装 Node.js，也不依赖项目源码目录或额外执行 Chromium 安装命令。

构建命令：

```powershell
npm --prefix apps/desktop run tauri:build
```

当前脚本使用 `tauri build --bundles none`，会生成 release 可执行程序，但尚未生成 MSI 安装包，也未接入代码签名和自动更新。它适合当前内部测试与部署验证，不应被描述为已完成公众安装包分发。

## 开发模式

开发模式仍使用本机 Node.js 和工作区依赖。第一次运行真实浏览器授权前执行：

```powershell
npm --prefix apps/desktop run install-browsers
npm --prefix apps/desktop run tauri:dev
```

也可以单独调试 Agent：

```powershell
npm run desktop:status
npm run desktop:heartbeat
npm run desktop:run-once
npm run desktop:watch -- --interval-ms 5000
```

## 授权与发布闭环

1. 用户在桌面端媒体账号目录点击某个平台的“一键授权”。
2. 桌面端创建并认领授权会话，打开该平台的持久化浏览器 profile。
3. 用户手动完成平台登录；adapter 必须确认已经进入后台或创作中心，并取得平台要求的强登录凭据。
4. Agent 回传 Cookie、localStorage 和 sessionStorage，后端加密保存并绑定媒体账号。
5. 用户从文章管理或编辑器发起发布，FastAPI 创建媒体订单并下发 `publish_article` 命令。
6. 桌面 Agent 执行平台专用发布流程，回写成功、审核中或失败状态。
7. 只有平台返回或公开复验得到真实文章 URL 时，系统才保存公开回链；不会生成占位 URL。

## 凭据与本地状态

设备 token 保存到 Windows Credential Manager，服务名为：

```text
cn.zhixin.ai.desktop
```

本地 JSON 状态文件只保存非敏感设备状态，不再包含 `deviceToken`：

```text
%USERPROFILE%\.zhixin-ai\desktop-agent.json
```

旧版本若在 JSON 中保存过明文 token，首次成功迁移到 Credential Manager 后会删除旧字段。Cookie 等媒体授权材料由后端加密保存，不应写入桌面日志。

## 日志与排障

Tauri 启动、资源目录解析、内置 runtime 选择和 Agent 拉起结果写入：

```text
%LOCALAPPDATA%\cn.zhixin.ai.desktop\desktop-startup.log
```

Agent 心跳、命令执行和 adapter 结果写入：

```text
%USERPROFILE%\.zhixin-ai\desktop-agent.log
```

若桌面壳可以打开但授权或发布没有反应，先确认：

1. `desktop-startup.log` 中存在 `agent_watch.spawned`。
2. `desktop-agent.log` 中持续出现 `watch.start` 和 `heartbeat`。
3. Docker 中 `api`、`worker`、`web`、`postgres`、`redis` 均为 healthy。
4. 对应媒体账号仍为有效授权状态，平台没有要求重新验证。

Windows 的 Tauri `resource_dir()` 可能返回 `\\?\` 扩展路径。桌面端在把入口路径传给 Node ESM 前会将其规范化为普通 Windows 路径，避免 Node 将盘符误判为目录并退出。

## 验证

```powershell
npm --prefix apps/desktop run check
```

Rust 验证需在 `apps/desktop/src-tauri` 目录执行：

```powershell
cargo test --bin zhixin-ai-desktop
cargo check
```