# mywasap 私人工作后台 · 0.1.0

这是 **GitHub + Railway 的可部署开发版本**。核心管理功能已实现；不能把本版本称为已验证的生产稳定版。真实扫码、发送回执、远程剪贴板、浏览器隔离和 16+ 号码负载，需要在目标 Railway 环境中验收。

源码仓库：https://github.com/AnonymousDANIEL/whatsapp 。后续更新采用直接提交此仓库的方式，并通过 GitHub Actions 自动运行测试和两个 Docker 镜像构建。完整流程见 [后续更新说明](docs/UPDATE_WORKFLOW.md)。Railway 需要首次连接仓库并配置服务；启用 Autodeploys 和 Wait for CI 后，后续提交可触发自动更新。

## 2026-10-14 侧栏点击展开

- Owner 的主菜单按 **总览 → 余额 / 充值 → WhatsApp 账号 → 公告管理 → USER ID 管理** 排列。余额下为 Online FPX、银行管理；充值单据和银行流水再嵌套在银行管理下。WhatsApp 下为发送任务 / 发送记录，USER ID 管理下为操作记录 / 服务状态。
- USER 的主菜单为 **总览 → 余额 / 充值 → WhatsApp 账号**，余额下为可用的 Online FPX / 银行充值，WhatsApp 下为发送任务 / 发送记录。主菜单和子菜单使用文字、缩进及当前页 / 所属组提示，去掉星号和装饰箭头；右侧保留展开 / 收起按钮。
- 总览默认仅显示主菜单；点击有下级的菜单文字展开 / 收起，并进入该菜单页面。右侧箭头只展开 / 收起选项，不切换页面；银行管理也可独立展开。点击下级选项进入对应页面，Esc 收起当前子菜单；刷新和后台更新保留同一登录会话的展开选择，退出后清空。
- Online FPX 设置、充值和订单集中到余额下的独立入口；余额 / 充值保留余额、流水及 Owner 的手动管理。FPX 关闭、配置未完成或 Sandbox 时，USER 入口隐藏；当前正在查看时回到余额。Owner 始终可进入 FPX 设置和核对旧订单。

## 2026-10-14 银行转账充值、单据与流水

- USER 在 **银行充值** 选择银行和金额，创建充值后查看收款账号 / 二维码，转账后仅上传单据。没有 Langkah、Rujukan、Cara Transfer、Masa Transfer、Nama Pemindah 输入；只能查看自己的订单和单据。
- Owner 使用分开的 **银行管理 / 充值单据 / 银行流水** 页面。可填写银行、户名、账号、二维码、私有备注和排序，设置开启 / 维护 / 关闭，以及整个银行转账系统的开关。关闭的银行从 USER 列表和二维码入口移除，维护银行显示维护状态并拒绝新订单；已经付款的订单继续核对。
- 单据不会独立增加 Credit。签名银行连接须返回已入账交易、订单 ID 和当前单据 SHA-256；核对银行、IN、金额、付款时间及交易未被使用后，原子入账一次并恢复符合条件的余额暂停任务。重复单据和已使用交易显示拒绝原因。缺少流水保留等待；只有完整覆盖已结束付款窗口的正式流水，或银行服务确认单据无效，才会自动拒绝。
- Owner 可先登记已在银行核实的 IN / OUT 记录，再对应单据人工确认；登记记录本身不会充值。银行流水支持银行、马来西亚日期、IN / OUT、描述 / ID 筛选及完整分页。银行余额仅显示连接服务提供的值，不把部分流水相加冒充真实银行余额。
- **真实银行 / AutoPay Pro 尚未连接**：示例只说明界面，没有提供服务名称、接口文档或授权。新增的是经过验证的连接协议，不能直接填网银密码就获得全部流水。实际自动读取、单据核对和维护通知需接上已授权的银行 / AutoPay 连接服务；接入说明见 [银行连接](docs/BANK_CONNECTOR.md)。银行默认关闭且不预置示例里的真实账户；原 FPX 继续由原开关管理。

## 2026-10-13 mywasap 品牌与整数余额

- 登录 / 登录恢复页、左侧栏使用提供的透明背景 mywasap Logo，去掉图片和样式的白底；浏览器标签使用同图的图标部分，网页标题统一 mywasap。Logo 版本地址同步更新，侧栏在高度不足时独立滚动，账号操作入口保持可访问。
- USER 余额显示原始整数单位，例如原来的 **RM 1000.0000 → 10000000**，去掉 RM 前缀、小数点和分隔符。USER 流水的余额变动 / 余额及 Owner USER ID 管理余额也使用整数；Owner 的 MYR 账务流水、单价、预扣和 FPX 付款金额保留货币格式。
- **RM 1 对应 10000 个显示单位**。只调整显示，数据库余额、历史流水和实际充值 / 扣费算法沿用原有整数计账，不增加或重算任何资金。

## 2026-10-13 USER 余额显示与状态管理

- USER 的 **余额 / 充值** 页显示自己的可用余额和余额流水（最近 100 条）。待结算预扣、每条消息单价、预扣明细及收费说明仅 Owner 可见；USER 流水不包含 Owner 的操作备注或身份资料。已启用的 Online FPX 充值入口仍可使用，历史流水继续保留。
- **USER ID 管理 → 顶部 Status / 状态筛选** 可分开查看 **ACTIVE、LOCKED、INACTIVE**，默认 ACTIVE，同一登录会话刷新后保留选择。筛选只改变显示；表格行内不再放修改状态的下拉框。
- Owner 在 **账号 / 状态 / 密码** 编辑窗口管理状态。LOCKED 表示锁定 USER 的后台访问，与 WhatsApp 连接状态无关；INACTIVE 表示停用。两者均撤销登录并暂停任务，解锁 / 启用后须重新登录，已暂停任务不会自动开始。现有账号默认未锁定，Owner 自己受保护。

## 2026-10-12 USER 备注、页面刷新与余额恢复

- **USER ID 管理 → 修改备注**：Owner 可保存每位 USER 的资料备注，最多 2000 个字符。创建 / 修改 USER 的表单也可填写备注；独立修改备注只改备注，USER 无法读取管理备注。
- 因余额不足暂停的任务显示 **余额不足 · 充值足够后自动继续**。手动充值或已验证 FPX 入账后，余额覆盖当前单价时恢复；worker 每五秒补查恢复。手动暂停、等待核对、取消、删除、停用或已撤销账号权限的任务不会因充值而自动开始。点击 **保持暂停** 可关闭某个任务的自动恢复。
- 自动恢复只继续未发送号码，保留批次数量和发送间隔，不重设收件人状态，也不重发已提交或结果不确定的消息。旧余额暂停仅在可识别且没有后续手动停止 / 未知结果时迁移。
- 页面按需并行读取数据；切换页面取消旧请求，后台刷新仅在实际显示数据改变时重绘。编辑公告、横向滚动和密码验证状态继续保留。发送记录 / 操作记录每页 100 条，导出仍包含完整任务结果。

## 2026-10-12 当前权限、密码与公告

- USER WhatsApp 账号行仅有扫码、启动 / 重连、修改名称。聊天画面与操作画面仅 Owner 可访问，包括直接 HTTP / WebSocket 请求。页面隐藏名额数字，每个 USER 的 10 个账号上限仍由服务器强制执行。
- 创建 / 修改 USER ID 填写 ID、密码、状态及资料备注，已移除 WhatsApp 账号分配说明及勾选列表。编辑提交沿用已有账号归属；新 USER 自行添加账号，默认上限 10 个。
- Owner 的 WhatsApp 账号页面和总览按分配的 USER ID 展示独立区块；未分配账号在 Owner 区块。共享分配账号会出现在各对应 USER 区块，其他 USER 无法读取分配人员信息。
- USER 已移除「修改密码」入口，后台也拒绝 USER 自行修改密码。只有 Owner 可以在 **USER ID 管理 → 账号 / 状态 / 密码** 重设 USER 密码；留空不变，更改后该 USER 的所有登录会话立即失效。Owner 可继续修改自己的密码，需要验证当前密码。
- 在 **USER ID 管理 → 密码旁的查看** 验证 Owner 密码后，USER 密码明文显示五分钟。有效验证会随同一登录会话恢复，刷新不再强制隐藏；验证到期提示重新验证。Owner 重设 USER 密码约五秒内更新。没有保存的历史密码仍须由 Owner 合法重设，不自动重设任何密码。
- Online FPX 关闭或未准备好时，USER 页面不显示 FPX 区块。Owner 始终可在 **余额 / 充值** 查看关闭状态、订单及设置开关；已付款订单仍按原规则核对入账。
- Owner 在 **公告管理** 填写中文 / 可选英文内容并开启，公告显示在全部 USER 页面顶部，约五秒内更新。关闭后隐藏公告；未发布草稿仅 Owner 可读。编辑中的公告不会被定时刷新覆盖。

## 2026-10-02 更新（历史）

- 后台中文 / English 切换；原版 WhatsApp 的语言由 WhatsApp 自身设置控制。
- 日期输入、显示和服务器浏览器统一马来西亚 UTC+8；可修改任务时间，立刻发送保留原计划。
- 刷新先恢复现有登录，不闪现登录页；远程画面中断有界重连，明确区分服务、画面与 WhatsApp 状态。
- 修复消息 ID / 回执缺失导致的保存错误；未知发送暂停相关任务，不关闭已连接浏览器、不自动重发。重连时仅对唯一匹配的历史消息核对回填。
- 新增发送内容记录、账号改名、Owner 全局查看。手动发送的操作者按当前控制会话关联，不能证明每条消息一定来自该用户；不记录全部键盘行为。
- USER 删除保留资料及操作记录；Owner 可永久清除应用任务、结果、发送和操作记录。保留登录 ID 与连接，不清除 WhatsApp 聊天、Railway 日志或备份。

## 本版本包含什么

- 分开的总览、WhatsApp 账号、发送任务、结果报表、员工权限、操作记录、服务状态页面。
- Owner、USER ID 登录账号，密码哈希、服务端会话、CSRF 校验、登录限流。
- 只有 Owner 管理 USER ID；所有 USER 功能一致，只能访问分配给自己的 WhatsApp 账号。
- 每个号码使用独立 Chromium / Unix 身份 / 私有登录目录 / 受认证的独立 X 显示器。
- 网页内通过 noVNC 显示服务器上实际运行的 WhatsApp Web，保留 WhatsApp 当前原版界面；不是仿制的聊天页面。
- 每日发送窗口、日期范围、星期、跨午夜窗口；文字发送任务的暂停、恢复、取消。
- 新建任务和已有任务均可“立刻发送”：保留全部时间设置，跳过开始/截止日期、星期和发送时段，按原发送间隔处理待发送号码。
- TXT / 单列 CSV / 粘贴号码列表，马来西亚本地号码规范化、国际号码校验、去重。
- PostgreSQL 保存任务、联系人明细、回执、会话和操作记录。每个号码顺序派发，一个分组仅允许一个活跃 worker。
- 号码无效、未注册、发送失败、已提交、送达、已读、待确认的明细和 CSV 导出。
- USER 停用后撤销登录并暂停其任务；旧 Manager/Staff 自动迁移为 USER，保留账号密码和已有分配。
- 原版页面可操作窗口占用期间暂停该号码自动发送；关闭后最多约 30 秒恢复派发。

### 立刻发送的使用方式

在“发送任务 → 新建任务”填写任务名称、消息、联系人并确认接收同意后，可直接点击“立刻发送”，无需调整日期、星期和时段。原来的“创建并按计划启用”按钮和所有时间字段保留。已有任务只要还有待发送号码，也可以在操作栏点击“立刻发送”。

立刻发送启用该任务的立即模式，并在账号可用后的下一个发送机会优先处理，仍遵守号码的发送间隔；不会重新发送已提交、失败、无效或待确认的号码。时间设置继续保存在数据库中，成功/失败分类和报表不变。

## 必须理解的边界

1. **原版界面不等于所有功能都完成转接。** 本版本显示并控制远程浏览器。用户电脑的文件选择、音频、麦克风、摄像头、电话通话、下载和图片剪贴板没有自动转接。历史聊天显示范围由 WhatsApp 自己的同步决定。当前未实现本地附件上传/下载桥接和自动媒体任务。文字、扫码和原版键鼠操作需真实验收。
2. **可操作权限是原版页面的整体操作权限。** 它包含发送、删除聊天、设置、退出账号等原版可用操作。无法在保持页面完全原样的同时承诺按原版菜单细分权限。USER 在其分配的账号内可查看、操作、建任务和导出；只看入口仍可用于观察。只看通道由 x11vnc 服务端限制输入，不能只靠前端 viewOnly 参数。
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

账号名称/号码仅作备注，登录必须用手机扫码。账号页提供“检查连接”，扫码窗口会说明服务离线、配置或权限问题。首次浏览器服务配置见 [部署步骤](docs/RAILWAY_SETUP.md#已添加号码但未扫码先启动浏览器服务)。

### Online FPX setup

Owner: open **Credit / top-up → Online payment settings / switch**.
1. Add and verify your settlement bank account in your Billplz merchant dashboard.
2. Create a dedicated Collection and enable only FPX for it.
3. Fill in live Collection ID, API Secret Key and X Signature Key in this dashboard. Keep X Signature callbacks enabled in Billplz.
4. Select Live payments and turn online top-up on. Turn it off during maintenance to stop new orders; already completed orders continue to credit safely.

The service receives payment callbacks at `/api/payments/callback/<order-id>` and returns the browser to `/?topup=<order-id>`. `PUBLIC_URL` must be the real HTTPS public origin. Payment credentials and newly saved USER passwords require a stable random 32-byte `APP_VAULT_KEY` (64 hex characters), set only on the API service. Preserve this key across redeploys; do not commit it. Existing bcrypt passwords cannot be recovered; only the Owner can reset USER passwords to make them available through the verified five-minute password view. USER self-service password changes are disabled on both the page and API. The worker capacity is separate from the default ten-account limit for each USER.

## 2026-10-14 共享 WhatsApp 发送

- 原个人账号保留，新增独立的 **共享 WhatsApp → 共享发送任务 / 共享发送记录**。Owner 录入、连接、管理共享号码；USER 只能提交自己的消息、查看自己的任务及号码结果，直接 HTTP / WebSocket 访问也不能登录共享账号。
- 支持每次录入 200 个、最多 1000 个号码资料，按已配置分组分配。新号码须先在手机 WhatsApp 完成真实短信 / 电话验证，再由 Owner 扫码连接；网页录入不会替代注册。连接身份必须与登记号码一致。
- 共享功能默认关闭、价格未设置。Owner 可设置独立默认每条单价及 24 个每日马来西亚小时单价，并设置发送间隔 / 每批数量。按消息实际开始派发的小时价格预扣，使用原余额；Owner 无限。此模式为每条收费，按小时改变单价，不是账号每小时租金。
- 已确认失败 / 号码无效按原预扣金额退回一次，成功结算一次，等待回执 / 未知结果保留待核对，不自动重发。幂等请求防止同一次重试重复建任务；余额不足暂停的待发任务充值足够后继续。仅待发消息可改用另一健康账号，已发送消息按原发送账号核对。
- 每小时读取实际客户端状态，结合真实手机号和 worker 心跳展示连接数量；未知 / 离线加做有界补查。无法确认状态不能计为已连接。新连接不会通过发消息来探测。
- **100+ 号码资料不等于 100+ 同时在线**。每个 worker 最多 10 个独立浏览器；超过 100 同时在线需要至少 11 个健康分组、各自持久卷和足够内存 / CPU。未进行真实 100+ 账号负载验收。
- 可选 `SHARED_WORKER_GROUPS_JSON` 指定专用共享分组列表，须为 `WORKER_ROUTES_JSON` 中的键；指定后普通个人账号创建和 USER 分组列表不包含这些专用分组。未指定时与既有分组共用容量。每个 worker 使用唯一 GROUP / 登录卷，禁止通过复制同一个 profile 增加实例。worker 默认数据库连接池 5，API 默认 15，可用 `DB_POOL_MAX` 调整。
