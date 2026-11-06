# 社区版部署指南

本仓库采用MIT许可证，独立初始提交不携带原项目历史。使用GitHub Download ZIP或git clone获取源码；没有生产数据库、平台账号或现成私有安装包。

## 本地运行

Windows安装Node.js 20+、npm、Docker Desktop并启动Linux容器引擎，在解压目录执行：

```powershell
npm ci
Copy-Item apps/api/.env.example apps/api/.env
# 编辑apps/api/.env：填模型凭据；仅本地允许console验证码
npm run dev:docker
npm run verify:docker
```

网页：`http://127.0.0.1:3001`，API健康检查：`http://127.0.0.1:8000/health`。首次注册时验证码可在API日志查看；此模式只用于本地开发。启动完成后自行注册，不提供预置管理员密码。

Linux使用原生Compose时，先创建本地编排要求的外部卷（仅新环境使用）：

```bash
cp apps/api/.env.example apps/api/.env
docker volume create ai_zhixin_postgres_data
docker volume create ai_zhixin_redis_data
docker volume create ai_zhixin_uploads
docker compose -f docker-compose.yml up -d --build
```

本地Compose的数据库端口可能监听所有网卡，只在可信开发环境使用。公网部署使用生产Compose。没有模型密钥时可检查登录及管理界面，但不能据此期望真实生成成功；模拟数据也不是平台真实发布结果。

## 私有服务器

1. 准备Linux、Docker Compose v2、HTTPS域名与证书、SMTP及需要的模型/搜索服务凭据。
2. 从`.env.production.example`复制`.env.production`，替换数据库/Redis密码、SMTP账号、`AUTH_ALLOWED_ORIGINS`和`AUTH_TRUSTED_HOSTS`。生产保持`AUTH_DEBUG_RETURN_CODE=false`、`AUTH_COOKIE_SECURE=true`、`MEDIA_PUBLISH_FALLBACK_MOCK=false`。
3. 执行`docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet`校验，再执行相同前缀加`up -d --build`。
4. Nginx或其他网关将自己的HTTPS站点反向代理到`127.0.0.1:3001`。Next.js负责转发API、MCP与上传；MCP关闭代理缓冲并提供足够长的读取超时，上传限制按素材大小设置。数据库与Redis不对公网开放。
5. 配置自有桌面下载及更新文件，注册用户，验证`/health`、登录、API和Worker健康、桌面绑定、授权与一条受控任务。不要把线上智心AI的安装包当作已经配置好的私有客户端。

推荐先在测试服务器验收再切换域名。社区版未在全新Docker环境完成端到端部署测试；检查命令及配置不等于真实投稿验收。

## 桌面端连接自己的服务器

当前桌面界面与更新地址包含默认线上站点。环境变量只改变Node Agent地址，不会自动修改桌面Web页面和CSP。因此需要在**独立构建副本**中修改下列位置，再构建自己的Windows安装包：

| 文件 | 必须检查的内容 |
| --- | --- |
| `apps/desktop/ui/index.html` | iframe地址、`WEB_ORIGIN`、版本清单地址；删除或替换原服务器IP回退地址 |
| `apps/desktop/src/agent-core.mjs` | `DEFAULT_API_BASE_URL`，或明确设置`ZHIXIN_API_BASE_URL` |
| `apps/desktop/src-tauri/tauri.conf.json` | CSP中的frame-src/connect-src，只允许自己的服务地址 |
| `apps/web/public/downloads/desktop-version.json` | 自有安装包版本、下载地址和校验值，不能沿用原包哈希 |
| `apps/desktop/src/adapters/csdn.mjs` | `CSDN_PUBLIC_SNAPSHOT_API_URL`改为自己的`/api/public-snapshots/csdn`端点 |
| `.env.production` | `NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL`指向自己的安装包 |

替换时保留路径，只变更服务地址；全仓检索旧域名及服务器IP，区别平台业务地址、历史文档与运行配置。使用独立`ZHIXIN_DESKTOP_STATE`和测试用户，避免复用已有生产浏览器资料。并行安装多个定制客户端还需设计独立Tauri标识、凭据服务和用户数据目录，当前默认标识不能保证多实例隔离。

Windows构建机安装Rust、Tauri 1.x系统依赖、WebView2、Inno Setup 6后：

```powershell
npm ci
npm --prefix apps/desktop run install-browsers
npm --prefix apps/desktop run build:installer
```

输出位于`apps/desktop/dist`。发布前验证登录页面、用户绑定、平台授权及实际执行器连接的域名。社区版不提供预构建桌面下载清单，需自行生成，应以自己的构建产物更新清单。

## 适配器热更新与私钥

社区版不分发原项目公钥或私钥。先运行`node scripts/setup-community-signing.mjs`生成独立密钥。私有部署若要自行发布热更新，应创建自己的Ed25519密钥对，将公钥配置到桌面资源并重新打包，私钥留在受控构建环境；具体工具见`apps/desktop/scripts`。

未经签名验证的适配器不能作为可信更新分发。使用完整累积包保留其他平台版本，并检查最低桌面版本及依赖兼容性。桌面核心执行器改动需要安装包升级。

## 数据与恢复

数据库、文章上传、私有视频卷以及桌面资料分别持久化。现有`backup.sh`只覆盖数据库、文章上传及部署配置，不涵盖私有视频、签名密钥和桌面资料；这几部分需另做备份。当前清理规则为新备份验证成功后删除超过7天的完整备份、至少保留7份，不能依赖它清理全部磁盘内容。

不要直接在有数据的生产环境执行`docker compose down -v`。迁移前做恢复演练，保留可用镜像和配置。

## 许可证与验证边界
采用根目录MIT许可证；第三方依赖遵循其各自许可证。真实平台投稿、浏览器交互、全新Docker部署需要部署方自行验收。
原项目运维/验收文档不分发；此仓库不提供官方线上站点或下载地址。默认桌面连接本机3001，正式部署必须换成自己的HTTPS站点。
