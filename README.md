# WhatsApp 私人工作后台 · 0.1.0

这是 **GitHub + Railway 的可部署开发版本**。核心管理功能已实现；不能把本版本称为已验证的生产稳定版。真实扫码、发送回执、远程剪贴板、浏览器隔离和 16+ 号码负载，需要在目标 Railway 环境中验收。

源码仓库：https://github.com/AnonymousDANIEL/whatsapp 。后续更新采用直接提交此仓库的方式，并通过 GitHub Actions 自动运行测试和两个 Docker 镜像构建。完整流程见 [后续更新说明](docs/UPDATE_WORKFLOW.md)。Railway 需要首次连接仓库并配置服务；启用 Autodeploys 和 Wait for CI 后，后续提交可触发自动更新。

## 本版本包含什么

- 分开的总览、WhatsApp 账号、发送任务、结果报表、员工权限、操作记录、服务状态页面。
- Owner、Manager、Staff 登录 ID，密码哈希、服务端会话、CSRF 校验、登录限流。
- Manager 仅能管理自己名下 Staff；账号访问权限可设为无权限、只看、可操作。
- 每个号码使用独立 Chromium / Unix 身份 / 私有登录目录 / 受认证的独立 X 显示器。
- 网页内通过 noVNC 显示服务器上实际运行的 WhatsApp Web，保留 WhatsApp 当前原版界面；不是仿制的聊天页面。
- 每日发送窗口、日期范围、星期、跨午夜窗口；文字发送任务的暂停、恢复、取消。
- 新建任务和已有任务均可“立刻发送”：保留全部时间设置，跳过开始/截止日期、星期和发送时段，按原发送间隔处理待发送号码。
- TXT / 单列 CSV / 粘贴号码列表，马来西亚本地号码规范化、国际号码校验、去重。
- PostgreSQL 保存任务、联系人明细、回执、会话和操作记录。每个号码顺序派发，一个分组仅允许一个活跃 worker。
- 号码无效、未注册、发送失败、已提交、送达、已读、待确认的明细和 CSV 导出。
- 员工停用后撤销登录并暂停他创建的任务；停用 Manager 后其 Staff 也不能登录。
- 原版页面可操作窗口占用期间暂停该号码自动发送；关闭后最多约 30 秒恢复派发。

### 立刻发送的使用方式

在“发送任务 → 新建任务”填写任务名称、消息、联系人并确认接收同意后，可直接点击“立刻发送”，无需调整日期、星期和时段。原来的“创建并按计划启用”按钮和所有时间字段保留。已有任务只要还有待发送号码，也可以在操作栏点击“立刻发送”。

立刻发送启用该任务的立即模式，并在账号可用后的下一个发送机会优先处理，仍遵守号码的发送间隔；不会重新发送已提交、失败、无效或待确认的号码。时间设置继续保存在数据库中，成功/失败分类和报表不变。

## 必须理解的边界

1. **原版界面不等于所有功能都完成转接。** 本版本显示并控制远程浏览器。用户电脑的文件选择、音频、麦克风、摄像头、电话通话、下载和图片剪贴板没有自动转接。历史聊天显示范围由 WhatsApp 自己的同步决定。当前未实现本地附件上传/下载桥接和自动媒体任务。文字、扫码和原版键鼠操作需真实验收。
2. **可操作权限是原版页面的整体操作权限。** 它包含发送、删除聊天、设置、退出账号等原版可用操作。无法在保持页面完全原样的同时承诺按原版菜单细分权限。员工可设为只看；任务创建和报表导出另外控制。只看通道由 x11vnc 服务端限制输入，不能只靠前端 viewOnly 参数。
3. **扫码自动化不是 Meta 官方 API。** whatsapp-web.js 使用原版 WhatsApp Web 的内部接口；上游更新、账号限制、掉线均可能影响连接。不能保证永久登录、无封号或 100% 发送成功。只给已同意接收消息的联系人发送；本项目不提供规避限制、轮换账号重发或陌生号码采集。
4. **任务时间段只控制按计划派发，不会强制退出 WhatsApp 登录，也不会禁止员工手动发消息。** 按计划任务发送一轮列表，剩余号码可在之后的开放窗口继续处理；截止日期后剩余号码保持未发送。点击“立刻发送”会显式跳过这些时间限制并启用该任务，保存的时间数值不变；暂停、取消、账号停用、员工权限、发送间隔和原版页面操作占用仍会限制派发。暂停后恢复继续该任务的发送方式。两种方式均不会每天重新发送同一份完整列表，重复点击不会重置已提交、失败、无效或未知结果。暂停/停用/撤销权限不能撤回已经发出的网络请求。
5. **统计不能把无回执当成失败。** 成功 = `delivered + read`；失败 = `failed + invalid`。`submitted` 仅表示服务器回执；`awaiting_ack` 是消息已生成但未确认；`unknown` 是发送时超时/重启等结果不确定。用户关闭已读回执可能不显示 read；不能凭无送达回执判定被拉黑。
6. **未知结果不会自动重发。** 核对原版聊天后才决定是否新建任务。不存在可以跨 WhatsApp 网络调用和数据库提交保证“绝对恰好一次”的事务；本项目选择保留未知结果，降低重复消息风险。
7. 自动报表目前统计本系统创建的文字任务；员工在原版页面手动发送的消息不会纳入任务统计。操作日志记录进入页面、任务/用户/账号变更，不记录原版页面内每一次点击。
8. VNC 是远程画面；速度受服务器地区、网络、屏幕尺寸和同时查看人数影响。不要同时在多个操作窗口操控同一个号码。分组服务重新部署时会短暂停机；保留的登录可能恢复，也可能需要重新扫码。

## 16+ 号码的初始部署

采用一个管理服务、一个 PostgreSQL、四个浏览器服务；每组先限 5 个号码，可容纳 20 个号码。这个数量是配置容量，不是已完成负载测试的容量保证。先验收 2 个号码，再逐步增加到 5、10、16+，根据 Railway 实际内存、CPU、延迟和 WhatsApp 限制调整。不要承诺免费长期运行或固定服务器费用。

```mermaid
flowchart TD
  U["Owner / Manager / Staff"] --> A["管理网页与鉴权"]
  A --> D["PostgreSQL：权限、队列、回执"]
  A --> W["浏览器分组：A / B / C / D"]
  W --> D
  W --> P["各号码独立原版 WhatsApp Web"]
```

每个 worker 有自己独立的持久化卷，不使用同一分组的副本。详情见 [Railway 部署步骤](docs/RAILWAY_SETUP.md)。

## 本地运行

需要 Docker Compose（含 Chromium 的浏览器环境以容器为准）。先根据 `.env.example` 创建自己的 `.env`，另外添加 `POSTGRES_PASSWORD`。密码中含 URI 保留字符时，手工使用正确编码的 DATABASE_URL；Compose 示例建议使用随机字母数字密码。运行：

```bash
docker compose up --build
```

打开 `http://localhost:3000`，用 BOOTSTRAP_USERNAME / BOOTSTRAP_PASSWORD 登录。不要把 `.env`、登录目录和聊天文件上传 GitHub。

第一次 API 启动、users 表为空时创建 Owner；之后不再根据环境变量重置其密码。可以在后台修改自己的密码；忘记 Owner 密码需要由部署管理员在数据库执行经过哈希的密码重设。暂不提供邮件找回。

## 检查与测试

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm run check
npm test
```

默认运行纯函数测试。集成测试需要提供一个 **允许创建临时数据库** 的测试 PostgreSQL URL：

```bash
TEST_DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/postgres npm test
```

测试会创建、使用、删除 `wa_test_<随机ID>` 数据库，不会发送 WhatsApp 消息。TEST_SINGLE_DATABASE 仅为一次性测试实例使用；不要对生产数据库设置它。

依赖锁定在 package-lock.json。Chromium 使用 Debian 系统包；禁用 Puppeteer 下载，并通过本地 override 禁用其未使用的 ZIP 解压模块，以移除该上游依赖的已知路径遍历漏洞。不要调用 Puppeteer 的浏览器下载功能；如果以后修改浏览器安装方法，需要重新评估这个 override。

## 来源与许可

- WhatsApp 登录与内部接口说明：https://wwebjs.dev/ 和 https://docs.wwebjs.dev/Client.html
- 登录目录持久化：https://wwebjs.dev/guide/creating-your-bot/authentication.html
- WhatsApp 负责任使用：https://faq.whatsapp.com/361005896189245/
- Railway Docker：https://docs.railway.com/builds/dockerfiles
- Railway 卷限制：https://docs.railway.com/volumes/reference
- noVNC：https://github.com/novnc/noVNC （上游许可适用，其 LICENSE 文件由 npm 包保留）

本项目与 WhatsApp / Meta 无隶属关系，不是官网或官方产品。
