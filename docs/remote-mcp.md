# 远程发布MCP接入

自部署后使用自己的HTTPS域名。文章支持知乎、百家号、搜狐号、CSDN、网易号、企鹅号、头条号和简书；抖音使用视频工具。微信公众号未实现。

## 用户接入

1. 网页登录智心AI；在“媒体账号”授权目标平台，并让同账号绑定的桌面端在线。抖音桌面端须上报 `publish_video_v1`，旧客户端会显示升级要求。
2. 进入“自动化接入”，为每个客户端单独创建凭据。默认为只读；按需分别勾选“允许上传和发布视频”（publish:write）、“允许上传和发布文章”（article:write）。旧视频凭据不会自动扩权，使用文章写入需重新创建具有文章权限的凭据。有效期7/30/90/365天，最多20个有效凭据。
3. 明文只在创建时展示一次。把它保存在客户端运行环境的 `ZHIXIN_MCP_TOKEN` 中，不提交到Git、不放入模型提示词或共享配置。关闭后如遗失，撤销并重建。
4. 使用下列配置并重新打开客户端。不同客户端使用不同凭据便于单独撤销。

Codex `config.toml`：

```toml
[mcp_servers.zhixin-ai]
url = "https://zhixin.example.com/mcp"
bearer_token_env_var = "ZHIXIN_MCP_TOKEN"
```

也可执行：

```powershell
codex mcp add zhixin-ai --url https://zhixin.example.com/mcp --bearer-token-env-var ZHIXIN_MCP_TOKEN
```

Claude Code `.mcp.json`（合并现有mcpServers，不要覆盖已有配置）：

```json
{
  "mcpServers": {
    "zhixin-ai": {
      "type": "http",
      "url": "https://zhixin.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${ZHIXIN_MCP_TOKEN}"
      }
    }
  }
}
```

Claude Code首次加载项目配置可能要求信任该MCP；`claude mcp list`可检查连接。本版使用显式Bearer凭据，未实现浏览器OAuth发现/登录；不宣称支持仅允许OAuth的Claude网页自定义连接器。

## 工具与调用契约

| 工具 | 权限 | 作用 |
| --- | --- | --- |
| get_publish_capabilities | publish:read | 当前用户抖音账号、设备就绪状态与限制 |
| get_upload_instructions | publish:read | 获取专用上传路径与字段说明 |
| list_video_assets | publish:read | 当前用户私有素材，分页 |
| publish_video | publish:write | 独立填写作品标题/简介，选择立即或定时发布后入队；需confirmPublish=true与idempotencyKey |
| get_video_publication | publish:read | 按publicationId查询持久状态 |
| list_video_publications | publish:read | 当前用户队列及结果，分页 |
| recheck_video_publication | publish:write | 只排队回查已有作品，绝不重新投稿 |

write凭据同时包含read。分页默认20，最多100；返回 `nextOffset`，为null时结束。结果不包含原始浏览器profile、命令payload、登录凭据或服务器文件路径。业务拒绝通过MCP `isError=true`和 `{error,status}` 返回；协议参数不合法由官方SDK校验。

大文件上传路径：`POST /api/mcp/video-assets/upload`，使用同一Bearer凭据，multipart字段 `file` 与 `kind=video|cover`。视频MP4最大500MiB，封面PNG/JPEG最大10MiB，复用既有实际解码校验及私有存储。远程服务不能读取调用者电脑的 `C:/...` 路径，不接收任意URL代下载，也不把视频base64放进MCP参数。

PowerShell上传示例（file路径替换成真实成品文件）：

```powershell
curl.exe --fail-with-body `
  -H "Authorization: Bearer $env:ZHIXIN_MCP_TOKEN" `
  -F "kind=video" -F "file=@C:/Videos/finished.mp4" `
  https://zhixin.example.com/api/mcp/video-assets/upload
```

将响应 `id` 用于工具参数：

```json
{
  "assetId": "<上传返回的id>",
  "mediaAccountId": "<能力查询返回的账号id>",
  "title": "单独填写的作品标题（可选，最多30字）",
  "caption": "单独填写的作品简介 #话题（最多1000字）",
  "publishMode": "immediate",
  "idempotencyKey": "<本次发布意图唯一且重试复用的key>",
  "confirmPublish": true
}
```

`title` 与 `caption` 分别填写抖音作品标题和作品简介；不传标题时由桌面端按既有规则从简介推导。`publishMode` 可选 `immediate`（默认）或 `scheduled`。定时示例：

```json
{
  "assetId": "<上传返回的id>",
  "mediaAccountId": "<能力查询返回的账号id>",
  "title": "周五晚间发布",
  "caption": "用户确认后的作品简介 #话题",
  "publishMode": "scheduled",
  "scheduledAt": "2026-11-13T20:00:00+08:00",
  "idempotencyKey": "<本次发布意图唯一且重试复用的key>",
  "confirmPublish": true
}
```

`scheduledAt` 必须是带时区的 ISO 8601 时间，精确到分钟，且距调用时刻 2 小时至 14 天；定时仅对 `get_publish_capabilities` 中 `supportsScheduled=true` 的抖音账号开放，桌面设备也须具备 `publish_video_schedule_v1`。不支持时服务端拒绝入队。`get_video_publication` 与发布列表会回显独立标题、简介、发布方式和计划时间。不传coverAssetId时沿用原生AI封面；可使用私有封面素材ID选择自定义。沿用既有原生话题/智能章节准备流程，不包含团购功能。

入队返回 `publication.id` 与 `commandId`，不会阻塞等待上传到平台或审核结束。Agent退出后任务依然存在。`submitted_for_review`不是失败，`submission_unknown`不能盲目重发；只有 `published`表示通过既有公开回查。提交响应丢失仍复用同一幂等键，素材+账号内容身份也会去重。无itemId的未知结果需先人工核对，不伪造回查成功。撤销凭据阻止后续接入，不取消已入队任务。

## 只读连接验收

安装API依赖后设置 `ZHIXIN_MCP_URL` 与 `ZHIXIN_MCP_TOKEN`：

```powershell
python scripts/mcp-smoke.py
```

脚本使用官方SDK完成初始化、工具发现和只读调用，不发布视频，也不打印token。远程URL必须HTTPS，本地loopback允许HTTP。

本地已实测官方SDK、Claude Code 2.1.308的 `mcp list` 健康连接，以及已安装Codex app-server的 `mcpServerStatus/list` 发布工具发现；测试客户端使用独立配置目录和假用户，没有改动用户日常配置。

2026-10-26 已部署生产，并对公网 HTTPS 入口重复完成官方 SDK、Claude Code 和 Codex 原生连接验证。登录 [自动化接入](https://zhixin.example.com/agent-access) 即可创建自己的凭据，服务地址为 `https://zhixin.example.com/mcp`。真实多租户隔离、私有封面上传和撤销后 401 已验证；本次没有触发真实投稿。详见 `remote-mcp-verification-2026-10-26.md`。

## 部署与回滚

本次变更在现有未提交的抖音实现上增量工作。上线前必须把抖音API/worker/桌面能力作为依赖一起核对；不能只拷贝mcp_server.py，也不能只推adapter热更让旧客户端接受新命令。

1. 从审核后的源码构建API/worker共用镜像和Web镜像；优先独立构建机，避免在生产机跑重型构建和测试。API依赖新增 `mcp>=1.28,<2`；复用既有Record表，无本次新增数据库迁移。
2. 记录当前镜像标签、Nginx配置、桌面版本清单和可回滚副本；核对在飞任务，选择切换窗口。不得覆盖已有数据卷或private-video存储。
3. 确认生产 `AUTH_TRUSTED_HOSTS` 含服务域名，`AUTH_ALLOWED_ORIGINS` 为真实网页Origin（CLI无Origin可正常调用）。保留TLS，不开放后端8000公网端口。
4. `deploy/nginx/zhixin.example.com.conf` 已增加 `/mcp`及`/mcp/`直通18000，协议请求最大128KiB；MCP上传直通、关闭请求缓冲、允许502MiB multipart和600秒传输。后端只绑定 `127.0.0.1:18000`，由既有compose提供。Next也支持开发/独立运行下的/mcp转发和专用流式上传。
5. 在完整部署变更获得确认后，切换匹配的API、Web镜像；若业务/worker代码改变，须同步worker。仅新增MCP且worker业务未改变时可以保留现有worker，避免打断任务。保持worker_cli的每分钟media tick执行状态回查。准备启用视频的用户需要支持publish_video_v1的桌面版本。
6. 先 `nginx -t` 再reload。用测试用户验证网页凭据创建、只读MCP连接和撤销；401应是认证响应，不能跳转HTML登录页。验证用户A不能读取B的资产/发布记录。
7. 新视频真实投稿是额外对外动作，需使用明确授权的素材与账号；不要为上线验收复发此前已公开的视频。

回滚：先恢复上一版Nginx，恢复上一组API/worker/Web镜像；保留Record中的凭据摘要、发布任务和私有素材，不删除未完成记录。已向平台提交的任务不能靠回滚“撤销”；恢复后先回查已有作品ID，禁止批量重发。旧安装包继续由能力门禁阻止新视频命令。

## 文章工具与成品图文流程

新增工具均沿用同一 `/mcp` 地址，现有视频工具保持兼容：

| 工具 | 权限 | 用途 |
|---|---|---|
| get_article_publish_capabilities | publish:read | 八个平台支持情况、本人账号授权及桌面在线状态 |
| list_article_assets | publish:read | 本人文章图片元数据，有界分页 |
| import_article | article:write | 导入成品标题、Markdown、摘要、标签与封面，不生成、不发布 |
| list_articles / get_article | publish:read | 本人文章摘要列表 / 正文详情 |
| publish_article | article:write | 单个文章向一个本人媒体账号立即发布，需要确认和幂等键 |
| list_article_publications / get_article_publication | publish:read | 本人MCP任务及历史媒体订单，查询审核与公开证据 |
| recheck_article_publication | article:write | 去重请求既有作品状态回查，不会重发 |

文章图片通过 `POST /api/mcp/article-assets/upload` 上传，Bearer须包含article:write，multipart字段只有file，PNG/JPEG最大10MiB，经过实际解码。图片沿用已有素材库的公开URL访问模型；不应上传保密图片，视频仍保持私有存储。调用get_upload_instructions可发现两类上传接口。

文章发布需要绑定桌面端上报 `publish_article_v1` 能力位；旧桌面端会返回 `ARTICLE_DESKTOP_UPGRADE_REQUIRED`，升级桌面端后由心跳自动刷新设备能力，无需重新注册。`get_article_publish_capabilities` 的账号条目包含 `deviceSupportsArticles` 与 `error` 字段可直接判断。

```powershell
curl.exe --fail-with-body `
  -H "Authorization: Bearer $env:ZHIXIN_MCP_TOKEN" `
  -F "file=@C:/Images/finished.png" `
  https://zhixin.example.com/api/mcp/article-assets/upload
```

将响应id用于import_article参数，例如：

```json
{
  "title": "已创作完成的文章标题",
  "contentMarkdown": "## 第一节\n\n图片前的正文。\n\n!对应代码说明\n\n图片后的正文。",
  "summary": "文章摘要",
  "tags": ["技术"],
  "coverAssetId": "<上传返回的id>",
  "idempotencyKey": "<本次导入稳定唯一键>"
}
```

正文最多20000字符，行内图最多5张；图像只接受本人素材ID，不接受远程URL或本地路径。同键同内容返回原文章，换内容返回冲突；导入后返回article.id。向多个平台发布时，逐个选择get_article_publish_capabilities返回的mediaAccountId调用publish_article，每个目标使用自己的稳定幂等键：

```json
{
  "articleId": "<导入返回的article.id>",
  "mediaAccountId": "<本人已授权媒体账号id>",
  "idempotencyKey": "<这篇文章与此账号的稳定发布键>",
  "confirmPublish": true
}
```

返回publication.id为持久任务ID。网络重试复用同键；同文章/账号换键也不会再次入队。同键换目标或内容返回冲突。中途故障保留preparing/reconciliation_required并查回已有命令，不能把无响应当作未投稿。`submitted_for_review`、`pending_public_visibility`、`published_restricted`、`submission_unknown`均不等于已公开；只有已有验证证据满足时返回published和publicUrl。平台人工验证仍在桌面完成，不把Cookie交给AI。

文章列表仅返回摘要，详情按ID读取。发布列表同时包含历史媒体订单，MCP任务在回查后保留稳定ID。返回nextOffset为null时分页结束。

## 官方参考

- [官方Python SDK 1.x服务端挂载与生命周期](https://github.com/modelcontextprotocol/python-sdk/blob/v1.x/docs/server.md)
- [Codex远程MCP与Bearer环境变量配置](https://developers.openai.com/codex/mcp/)
- [Codex app-server MCP状态发现](https://developers.openai.com/codex/app-server/)
- [Claude Code远程MCP与环境变量展开](https://code.claude.com/docs/en/mcp)
