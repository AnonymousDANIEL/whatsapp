# GitHub + Railway 部署步骤

本文件不包含任何真实密码或 Token。部署前完成真实环境验收，不能仅凭健康检查绿灯判断 WhatsApp 可用。

## 首次部署崩溃：先检查数据库与变量

只有一个 GitHub 应用服务不能代替 PostgreSQL。若数据库尚未创建，在当前项目和环境添加 PostgreSQL；等数据库服务运行后，在 `whatsapp`（API）服务的 Variables 添加 `DATABASE_URL` 引用。数据库服务实际命名为 `Postgres` 时，引用写法为 `${{Postgres.DATABASE_URL}}`；名称不同应从 Add Reference Variable 选择实际服务，不要照抄名称。

Railway 中不要使用 `.env.example` 的 localhost 示例连接，也不要只在 PostgreSQL 服务内添加应用变量。API 服务还需要 `SERVICE_ROLE=api`、至少 32 位的 `INTERNAL_SECRET`、首次 Owner 的 `BOOTSTRAP_USERNAME` 和至少 12 位的 `BOOTSTRAP_PASSWORD`、实际 HTTPS 地址的 `PUBLIC_URL`。完整变量和浏览器分组配置见下面各节。

`dotenv` 的 `injected env (0) from .env` 只表示该次没有从 `.env` 文件注入变量，不能据此判断 Railway Variables 是否为空。新版已关闭这条提示。真正的启动失败会输出一条完整诊断，包含 `stage`、`codes`、`reason`、`hint`，并隐藏连接字符串、密码和密钥。

| 启动诊断 | 检查 |
|---|---|
| STARTUP_CONFIG_INVALID | 按 reason 补齐或修正 API 服务的变量；不是在 GitHub 添加 .env |
| ECONNREFUSED | 数据库是否已运行，DATABASE_URL 是否引用正确；应用容器的 localhost 不是独立数据库 |
| ENOTFOUND / EAI_AGAIN | 数据库域名和引用是否正确、服务是否在对应私有网络的同一环境 |
| 28P01 / 28000 | 数据库登录凭据是否已变更；重新引用数据库服务的 DATABASE_URL |
| 3D000 | URL 中的数据库名是否存在 |
| BOOTSTRAP_USERNAME / BOOTSTRAP_PASSWORD | 首次初始化 Owner 的 ID 和密码是否已填写 |

保存变量后应用待部署的更改。若仍崩溃，查看**最新部署**的 Deploy Logs 第一条 `Startup failed:`，按其具体代码处理。修正错误日志能显示原因，不能自动创建数据库或改变 Railway 的变量。

## 1. GitHub

本项目的仓库已确定为 https://github.com/AnonymousDANIEL/whatsapp 。直接从该仓库部署，根目录应有 package.json、Dockerfile、Dockerfile.worker、railway.json。不要上传 node_modules、.env 或 data。

后续更新代码由 Railway 从该仓库部署。更新前备份 PostgreSQL 和各组卷；先在测试环境验收 WhatsApp 连接。不要同时滚动升级全部组。

## 2. Railway 基础服务

创建一个 Railway Project，添加 PostgreSQL。创建 `api` 服务，从上述 GitHub 仓库部署。使用根目录 `railway.json`。给 api 生成公开 HTTPS 域名；浏览器 worker 不生成公开域名。

所有服务选择 main 分支，并启用 GitHub Autodeploys 和 Wait for CI。这样后续代码提交可以先运行 GitHub 检查，再触发部署。首次环境变量、服务和卷仍需配置；上传 GitHub 不会自动替你创建 Railway 项目。

选择用户附近的地区，并让 API、数据库、所有 worker 在同一地区；具体可选地区以 Railway 当时显示为准。

## 3. API 环境变量

| 变量 | 设置 |
|---|---|
| SERVICE_ROLE | api |
| PORT | 3000 |
| DATABASE_URL | Railway PostgreSQL 的私有连接字符串，建议用变量引用 |
| INTERNAL_SECRET | 自己生成的 64 位随机十六进制字符串；API 和所有 worker 必须相同 |
| PUBLIC_URL | API 实际 HTTPS 域名，例如 https://your-app.up.railway.app；必须与登录网页来源相同 |
| BOOTSTRAP_USERNAME | 自己选择的 Owner 登录 ID，3–40 位 |
| BOOTSTRAP_PASSWORD | 自己设定至少 12 位的唯一密码 |
| WORKER_ROUTES_JSON | 下一节四个分组到 Railway 私有域名的映射 |
| TRUST_PROXY_HOPS | 1；若更改代理拓扑，需重新检查 |

生成内部密钥时可运行 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。不要把输出粘贴到聊天或 GitHub。

WORKER_ROUTES_JSON 示例（替换成实际 Private Networking 域名）：

```json
{"group-a":"http://worker-a.railway.internal:8080","group-b":"http://worker-b.railway.internal:8080","group-c":"http://worker-c.railway.internal:8080","group-d":"http://worker-d.railway.internal:8080"}
```

名称来自各服务的 Railway Networking 设置；不要猜测。API 的 healthz 不会检查所有 worker，所以必须在后台验证每组心跳。

## 4. 浏览器分组

再从同一个 GitHub 仓库创建四个服务 `worker-a`、`worker-b`、`worker-c`、`worker-d`。

每个服务将 Railway Config File Path 设置为 `/railway.worker.json`。检查构建日志确认使用 `Dockerfile.worker`，不能误用 API 的 Dockerfile。如用环境变量配置 Dockerfile，设置 `RAILWAY_DOCKERFILE_PATH=Dockerfile.worker`，并确保根目录配置文件没有覆盖它。

| 服务 | WORKER_GROUP | 独立卷挂载 |
|---|---|---|
| worker-a | group-a | /data |
| worker-b | group-b | /data |
| worker-c | group-c | /data |
| worker-d | group-d | /data |

所有 worker 都设置：

| 变量 | 设置 |
|---|---|
| SERVICE_ROLE | worker |
| PORT | 8080 |
| DATABASE_URL | 同一个 PostgreSQL 私有 URL |
| INTERNAL_SECRET | 与 API 相同 |
| DATA_DIR | /data |
| MAX_ACCOUNTS_PER_WORKER | 5；先测试 1–2，再按资源调整 |
| RAILWAY_RUN_UID | 0；Node 负责建立隔离身份，Chromium 以各自的 Unix UID 运行 |
| RAILWAY_DEPLOYMENT_DRAINING_SECONDS | 90 |

worker 不需要 BOOTSTRAP_PASSWORD 或 PUBLIC_URL。禁用服务休眠 / Serverless，确保 worker 持续运行。API 定时处理的工作由持续运行的 worker 完成，不依赖用户电脑开机。

**必须一组一服务一卷，不要给同一 worker 分组开 replicas。** Railway 当前限制挂载卷的服务不能使用 replicas，卷重新部署有短暂中断。挂载卷前运行产生的登录数据不自动变成持久化数据。

浏览器服务需要创建子 Unix 用户与切换 UID，目标容器必须允许这些操作。遇到 `START_FAILED` / `DESKTOP_START_FAILED`，检查镜像、RAILWAY_RUN_UID、卷权限及 Railway 运行时；不要删除登录目录来掩盖问题。

## 5. 首次使用顺序

1. 登录 Owner，打开“服务状态”，确认四组心跳在线。
2. “WhatsApp 账号”添加第一个号码，选 group-a。
3. 状态进入待扫码后，点“打开操作 / 扫码”；手机 WhatsApp → 已关联设备 → 关联设备，扫描原版二维码。
4. 验证原版聊天同步、中文输入、文字复制、回复、回执；关闭操作窗口，等待占用释放。
5. 先创建 Manager，分配号码和功能权限；再由 Manager 创建 Staff。
6. Staff 登录后只应看见分配的号码，不能管理其他 Manager 的 Staff。
7. 使用你自己同意接收测试消息的号码建一个小任务，检查发送时间、暂停、送达状态、失败/无效号码列表和导出。
8. 停用 Staff，确认已登录会话关闭、任务暂停；重新启用后明确恢复任务，不自动恢复已暂停的任务。
9. 备份卷后重启一个 worker，确认保留登录和待发送列表；发送中的未知结果应要求核对，不应重复发送。
10. 最后逐步增加号码，检查 Railway Metrics 的 **整台容器** 内存和 CPU。后台 Node RSS 不包含浏览器内存。

## 6. 常见状态

| 状态 | 处理 |
|---|---|
| 待扫码 | 打开操作窗口，手机扫码 |
| 分组已满 | 调整资源和上限，或添加新独立分组；不要强行复制登录目录 |
| 服务离线 | 检查 worker 部署、私有域名、数据库及密钥一致性 |
| 登录验证失败 | 可能需要手机解除旧关联并重新扫码；不要反复发送 |
| WhatsApp 初始化失败 | 检查上游 whatsapp-web.js 与当前 WhatsApp Web 兼容性；更新前用测试号码验证 |
| 结果待确认 | 打开原版聊天核对是否已经发出；系统不会自动重发 |
| 已提交但未送达 | 保留等待；无法据此判断号码错误或拉黑 |

没有必要给 worker 公网端口；不要公开 VNC、数据库或 Chromium 调试端口。给工作人员的是后台账号，不能给 Railway、数据库或 Owner 密码。

## 7. 升级前保留的数据

- PostgreSQL：用户、权限、任务、回执、结果、会话和审计。
- 各组 /data：私有浏览器登录目录、Unix 身份映射和 X 身份文件。
- Railway 环境变量：密钥与服务路径（单独保管）。

这三个部分都必须妥善备份。不要将浏览器卷下载后提交到 GitHub。备份恢复需要独立流程验收；当前代码没有提供一键迁移号码到其他分组的工具。
