# 验证范围 · 2026-10-01

本版本是可部署开发源码，不是已经上线并验收的生产系统。

## 已完成

- JavaScript 语法检查通过。
- 11 项纯函数测试通过：号码校验/规范化/去重、开始和结束边界、跨午夜、停用和日期截止、全天窗口、立即模式绕过时间但保留计划、立即模式暂停/取消、无效计划拒绝、回执分类、Manager 管理范围、CSV 公式注入防护。
- 1 个综合集成测试通过（内部有多项 HTTP / WebSocket / 数据库断言）：Owner 引导登录、CSRF、Manager/Staff 创建和分配、跨团队访问拒绝、聊天入口来源校验、未登录入口拒绝、联系人批量保存和去重、状态统计、员工停用撤销登录/暂停任务、Manager 停用、审计、号码未注册、已提交/未知发送结果、先到回执保存、回执不降级。
- 集成测试已分别在 **PGlite WASM PostgreSQL** 和 GitHub Actions 的临时 **原生 PostgreSQL 17** 上通过；首次远程运行的原始测试集为 10 项通过、0 项失败、0 项跳过。未验证 Railway 数据库、多个 worker 的互斥与高并发行为。
- 新增 4 项启动诊断测试通过：缺失配置一次列出、真实拒绝连接时保留错误代码、无效 URL 在连接前退出、嵌套异常和循环 cause 中的凭据隐藏。修改前已用关闭的本地 TCP 端口复现只有 `Startup failed:` 的空白日志；修改后明确报告 `ECONNREFUSED`。没有连接生产数据库或真实 WhatsApp。
- 启动诊断改动当时的本地组合测试为 13 项通过、0 项失败、1 项集成测试跳过（当时本地未提供 TEST_DATABASE_URL）；其远程原生 PostgreSQL 17 测试与两个镜像构建已通过：[运行 36854501875](https://github.com/AnonymousDANIEL/whatsapp/actions/runs/36854501875)。本次新增立即发送的检查范围见下节。
- 初始版本浏览器检查通过：实际登录界面、创建号码、Manager/Staff 管理表单、权限分配、创建文字任务、号码去重、结果列表、导航、桌面及移动宽度。测试使用一次性数据，无 WhatsApp 连接，无真实发送。
- 安装锁文件可重现检查通过；生产依赖 npm audit 未发现已知漏洞。该结果不等于整个系统没有安全问题。
- 已加入 GitHub Actions：main 更新后自动使用临时原生 PostgreSQL 运行测试，并构建 API / worker Docker 镜像。首次远程检查的三个任务全部通过：[运行 36850795621](https://github.com/AnonymousDANIEL/whatsapp/actions/runs/36850795621)，对应提交 `f56674941f69d2972fa9f490dd7b2dedfae89bb1`。
- API 与 worker 的最终 Docker 镜像均在 GitHub Actions 成功构建；该检查验证构建步骤，不验证扫码或运行时行为。

## 本次更新：立刻发送

- 新建任务和已有任务均提供“立刻发送”。开始/截止日期、星期、每日窗口、时区和发送间隔保存在原字段中，没有改写为当前时间或全天。按计划发送继续采用原逻辑。
- 原有数据库通过可重复执行的新增列迁移获得立即模式，现有任务默认保持按计划发送；迁移测试核对原任务及其时间设置。
- `npm run check` 通过；`npm test` 在未提供测试数据库时为 15 项通过、0 项失败、1 项集成测试跳过。
- 使用一次性 PGlite WASM PostgreSQL 和临时 pg 适配器执行完整集成测试，父用例与 3 个子用例全部通过，0 项失败、0 项跳过。覆盖新建立即任务、已有任务时间完整保留、重复点击不重建联系人、已提交/未知/失败/送达状态不重置、CSRF、跨团队/只看/缺少任务权限拒绝、暂停、取消、账号停用，以及真实 worker 派发 SQL 的立即任务优先级和 25 秒间隔。
- 使用假 WhatsApp 客户端验证队列和发送前的暂停复查；没有连接真实 WhatsApp、没有发送实际消息。
- DOM 交互检查通过：保留默认时间即可立刻创建、原计划按钮正确提交、日期/时段/间隔原值保留、两个提交按钮同时禁用避免重复提交、已有任务立即按钮、Staff 的任务范围。此检查使用 jsdom 和假 API，不能替代真实浏览器渲染验收。
- 本次环境没有可运行的 Chromium，下载浏览器未成功，因此新增按钮的真实浏览器布局未在本地验证。原生 PostgreSQL 17 测试与 API / worker 容器构建由 GitHub Actions 对本次提交执行，以该提交的运行记录为准。

## 尚未验证 / 尚未提供

- 未运行最终 worker Docker 镜像验证多 Unix UID、Xvfb、x11vnc 与系统 Chromium 的完整组合。
- 未连接真实 WhatsApp、未测试扫码、真实回执和 WhatsApp 更新后的内部 API 兼容性。
- 未对原版页面进行文件上传、下载、声音、麦克风、视频/音频通话转接；这些功能当前未实现桥接。
- Railway API 的 /healthz 已返回 HTTP 200；未验证浏览器 worker、Railway 私有网络和 WebSocket 端到端连接。API 健康不代表 WhatsApp 已登录。
- 未验证 16+ 个号码同时运行的 CPU/内存、连续运行、断网重连、更新部署和备份恢复。
- 源码已上传至 AnonymousDANIEL/whatsapp；后续提交和自动检查以该仓库的实际历史与 Actions 记录为准。

上面的缺项不能由 HTTP 健康检查或纯函数测试替代。正式使用前按 RAILWAY_SETUP.md 的验收步骤逐项验证。

## 本次更新：扫码连接诊断

- 语法检查通过，普通测试 23 项通过、0 项失败、1 项数据库集成跳过。完整一次性 PGlite 集成父用例和 4 个子用例全部通过；使用临时适配器，不等同原生 PostgreSQL。
- 新增假 HTTP worker 测试覆盖地址错误、离线、认证失败、错误分组、版本不一致、上游异常脱敏及启动失败不能返回成功。
- 集成覆盖账号创建部分失败、连接查询权限、启动错误、没有分组心跳时显示离线、IPv6 健康访问；原立即发送与员工范围测试保留。
- jsdom 检查通过：离线说明、手机扫码提示、启动入口、权限拒绝；原任务交互检查通过。未做新页面的真实浏览器布局验收。
- 原生 PostgreSQL 17 与两个 Docker 镜像由本次提交的 GitHub Actions 验证。真实扫码和发送仍需目标环境验收，没有发送测试消息。

## 2026-10-02 浏览器镜像选择修正

- Railway worker 构建日志显示实际加载根 Dockerfile（API），即使服务已设置 Dockerfile.worker。移除根 railway.json 的 dockerfilePath，避免覆盖各服务的 Dockerfile 路径。API 默认使用根 Dockerfile，worker 服务使用 Dockerfile.worker。
- 新增脱敏桌面进程/浏览器初始化日志。语法检查和 23 项本地测试通过，数据库集成未在本地运行。实际构建路径及部署状态另查 Railway 日志；手机扫码、真实发送仍不能用健康检查替代。

## 2026-10-02 USER ID、时间、回执与双语更新

- `npm run check` 通过；普通测试 25 项通过、0 失败、1 项数据库集成跳过。
- 独立一次性 PGlite 测试 8 项通过：7 个子用例及父用例。覆盖 USER 范围/CSRF、马来西亚时间转换、立即模式保留、回执缺失/字符串 ID/不倒退、未知结果不关闭浏览器/不重发、只读核对、软删除与 Owner 清除、旧角色迁移、停用撤销登录。未操作生产数据。
- jsdom 假 API 验证中英文 × Owner/USER 四种组合：刷新恢复前登录页隐藏、恢复成功、权限导航、新建立即任务保留日期和 UTC+8、英文任务界面无中文残留。不是实际浏览器布局验收。
- 原生 PostgreSQL 与两个容器镜像由本次提交 GitHub Actions 执行，最终结果以该提交 CI 为准。未进行真实客户消息发送、长期断线压力测试、真实手机端的发送来源归属验证。
- 发送历史从新版开始捕获；以前没有保存的记录无法保证完整恢复。只读核对仅恢复唯一匹配项，不猜测、不自动重发。

## 2026-10-02 发送记录恢复与移除重复报表

- 移除结果报表导航；旧页面位置自动回到发送任务。任务、明细和导出保留。
- 每 15 秒只读核对已加载的最近七天外发消息及相关任务聊天，绕过完整模型序列化；保留真实 ID/时间/回执。唯一匹配的未知结果才回填，不自动重发。
- 发送记录显示最近核对时间及失败提示。读取历史不猜测操作者。Owner 删除用不可逆消息 ID 哈希防止同步重新生成内容，不保存被删除消息内容或删除操作日志。
- 本地普通测试 26 通过、数据库项跳过；独立 PGlite 集成 9 通过，覆盖漏事件恢复、去重、回执、删除后不重建。中英文 DOM 检查通过。原生 PostgreSQL 与两个容器由本次 GitHub Actions 验证。
- 没有发送真实测试消息。历史恢复依赖 WhatsApp 当前设备可读取的数据，不能以构建成功保证所有旧消息恢复。

## 2026-10-02 USER 创建时间与 WhatsApp 账号删除

- USER ID 列表显示数据库原始创建时间，统一 UTC+8。
- USER 删除限定已分配账号：停用、暂停任务、隐藏入口，Owner 保留查看及删除记录。Owner 删除为异步清理：worker 等待正在发送/核对结束，关闭浏览器，清除该账号服务器资料和关联后台数据。
- 删除按钮明确范围并要求确认；不注销手机上的 WhatsApp 账号。没有对生产账号执行删除测试。
- 临时数据库覆盖越权/CSRF、创建时间、删除后不可启用、任务暂停、USER 留记录、Owner 清理；双语页面用 DOM 检查。

## 2026-10-02 UTC 与任务照片上传

- 用户明确选择 UTC+0；后台显示、日期输入、默认计划与服务器浏览器改为 UTC。旧马来西亚时段转换为 UTC，日期瞬间保持不变，跨午夜和整日窗口转换覆盖星期边界。
- 新建任务增加独立照片入口、预览、移除；支持 JPEG/PNG/WebP 最大 5 MB，文字可作为说明，也可只发照片。号码导入保留并单独标注。图片通过权限校验后保存于任务，列表不返回 base64；缩略图端点同样校验账号范围。
- 28 项普通测试通过；临时 PGlite 集成 11 项通过，含 UTC 一周逐小时等价性、图片存储/权限和假客户端图片发送。中英文 DOM 检查通过：照片预览、空说明提交和 UTC 时间字段。
- 未向真实联系人发送照片。图片结果不确定时不会凭相同说明文字推断成功，也不会自动重发。图片发送兼容性需实际使用后确认。

## 2026-10-02 间隔批次与号码明细

- 恢复马来西亚 UTC+8 显示和浏览器时间。新建/编辑任务移除日期、每日窗口与星期限制，改为间隔单位和每批数量；既有任务一次性切换立即模式，暂停状态保留。
- 每批顺序发送，批次完成后等待间隔；批次计数保存在数据库。等待、未知、失败不会作为已送达；未知发送仍暂停，不自动重发。
- 发送记录合并任务号码状态和手动消息，按真实消息 ID 去重；任务保留原始电话号码，包括等待/无效/失败号码。
- 仅使用假发送客户端及临时数据库验证，不向真实客户发送测试消息。

## 2026-10-02 总览图标、消息状态及七日走势

- 四张图标卡片显示全部消息、发送成功、失败和等待；十种详细状态分开显示。成功包含提交/送达/已读，失败包含无效号码，界面明确说明。
- 新聚合接口统计可见、未删除账号的全部现有消息，不受任务列表 200 条限制；按账号和消息 ID 去重。七日走势使用首次发送日期及马来西亚时区，未开始发送的号码不计入走势。
- 语法检查通过；普通测试 28 通过、数据库项跳过；临时 PGlite 集成 13 通过，新增权限隔离、重复消息、七日补零和马来西亚午夜测试。中英文空数据和有数据 DOM 检查通过。
- 没有发送真实消息。DOM 检查不等同于真实浏览器视觉验收；原生 PostgreSQL 和两个镜像构建由 GitHub Actions 验证。

## 2026-10-11 Prepaid USER credit and Owner-only WhatsApp controls

- Added MYR credit (1 Credit = RM 1), integer arithmetic to four decimal places, shared editable per-message price, Owner-only manual positive/negative adjustments, idempotent adjustment request IDs, and separate credit ledger. All existing/new USERs begin at zero; Owner is exempt. Initial price is deliberately unset: this is a WhatsApp Web system, not the official Business Platform, whose country/category pricing must not be presented as this system's tariff.
- Task dispatch atomically locks the wallet and reserves the current rate before any send; inadequate credit pauses the task. Successful submission settles once, failures refund, uncertain results retain the hold and never auto-retry. Owner can explicitly review unknown holds. Rates are snapshotted per attempt; historical sends are not billed. Ledger survives chat/task deletion; unresolved holds block destructive purges.
- USER accounts have view-only WhatsApp access. Server rejects control/QR, start/reconnect, and account management, including direct WebSocket control requests. View requires a linked account; worker blocks frames when the connection is no longer ready. USERs cannot alter another creator's tasks to borrow Owner's free sending. Group labels now display WhatsApp while internal routing keys remain intact.
- Syntax and ordinary tests passed (28 pass, database item skipped there). Disposable PGlite integration passed 15 tests including credit defaults, scope, adjustment deduplication, overspend protection, exactly-once settlement, unlimited Owner, and blocked control requests. Chinese/English Owner/USER DOM checks passed. Native concurrent PostgreSQL locks and both production images are additionally checked by GitHub Actions.
- No live WhatsApp test messages, real top-ups, or production data deletions performed. No card payment processor added: Owner records manual top-ups. Real desktop rendering and QR behavior need live user verification; DOM/server tests do not substitute for that.

## 2026-10-11 Online FPX, USER linking slots and Owner password viewing

- Integrated Billplz bill checkout, Owner merchant configuration and online on/off switch. API Secret Key and X Signature Key are encrypted; no secrets are returned by settings reads. Collection should be configured for FPX only in Billplz. Production receipt validation verifies HMAC plus the server-fetched bill identity, collection, exact amount and order reference. Wallet lock and unique order ledger entry prevent double credits. Existing completed orders still settle during maintenance. Browser redirects cannot grant credit; sandbox payments cannot grant real credit.
- USER can add and link up to 10 assigned WhatsApp accounts, rename and restart them; only four row actions are shown. Limits are locked server-side during account creation and Owner assignment, including concurrent requests. Scan uses the read-only browser port and disconnects when ready, preventing a free interactive sending window. Owner keeps full controls. Existing accounts and grants are preserved; resource availability still bounds total simultaneous browsers.
- Owner can verify their own password to view encrypted USER passwords for five minutes. New USER passwords, Owner resets and USER changes are encrypted with purpose-bound AES-256-GCM under APP_VAULT_KEY; login still uses bcrypt. Existing password hashes cannot be reversed, so historical passwords show unavailable until legitimately reset or changed. Password changes and timestamps are reflected on the management page's five-second refresh. Owner passwords are never included in this vault or response.
- Removed the specified service-fee paragraph and ledger Actor/note column. Internal financial audit fields remain intact.
- Local syntax checks passed. Ordinary tests: 30 passed and database item skipped; disposable PGlite integration: 18 passed. Added coverage for concurrent ten-slot enforcement, QR-only restrictions, signed/forged callbacks, amount mismatch, duplicate callbacks, maintenance after an order was created, stored configuration snapshots, password viewing authorization and USER changes. Chinese/English Owner/USER DOM checks passed. PostgreSQL concurrency and both Docker builds are verified in GitHub Actions.
- No real bank transaction, live WhatsApp send, account deletion, or user password reset was tested on production. FPX remains off until the Owner supplies verified Billplz merchant keys/Collection ID and enables live payments. Actual FPX checkout, provider fees, bank settlement and ten-browser load still require live merchant/target-environment validation.

## 2026-10-11 USER interface, account groups and notices

- USER chat viewing is removed from account rows and denied on connection HTTP and WebSocket paths, including linked accounts. QR-only linking, restart and rename remain; the ten-account server limit remains without a visible slot ratio.
- Owner account lists are separated by assigned USER ID; unassigned accounts have their own Owner section. Account assignment identities are returned only to Owner. FPX unavailable/off is hidden entirely from USER pages; Owner retains an explicit Off state and the maintenance control. Existing completed payments are still validated.
- Password cells have direct View buttons instead of unexplained masking dots. The current five-minute verification state is restored via the same session after refresh; expiry produces a clear renewal prompt. Actual USER password changes still refresh within approximately five seconds, with no production reset or credential access performed.
- Added a singleton bilingual Owner notice with server-enforced Owner editing, length/empty-content validation and CSRF checks. All signed-in USER pages show the published text above the page header; disabled drafts are hidden from USER API responses. Text is escaped rather than executed; unsaved Owner editor changes survive periodic polling.
- Local JavaScript syntax checks passed. Ordinary tests: 30 passed, database test skipped there. Disposable PGlite integration: 19 passed, including the parent; covers linked USER chat-view denial over HTTP/WebSocket, verification state restore/expiry, private account assignments and notice authorization/publication/disabled drafts. Chinese/English Owner/USER jsdom checks passed, including maintenance visibility, safe notice/password text, group separation, password view/change/expiry, quota hiding and unsaved notice edits. PGlite transaction serialization does not substitute for native PostgreSQL concurrency; PostgreSQL 17 and both container builds are run by this commit's GitHub Actions.
- No real WhatsApp message, bank payment, production password reset/deletion or live announcement was performed as a test. Actual browser layout and long-term load are not validated by jsdom or API health checks.

## 2026-10-11 Remove WhatsApp assignment area from USER forms

- Removed the assignment explanation and account checkbox list from both USER create and edit dialogs. Both submissions omit grants: the existing API preserves assignments on edit and creates new USERs without preselected accounts; the server's default ten-account limit remains.
- Syntax checks passed; ordinary tests: 30 passed and the database item skipped locally. Chinese/English Owner/USER jsdom checks passed, including create/edit dialogs with no assignment area and submitted POST/PATCH bodies without grants. No new backend/database logic was introduced. PostgreSQL tests and both image builds continue in GitHub Actions.
- No production USER or WhatsApp account was created, reset, reassigned or deleted for testing.

## 2026-10-12 USER remarks, responsive refresh and automatic credit recovery

- Added Owner-private USER remarks (maximum 2000 characters) to create/edit forms and a separate remark-only endpoint. Permission/CSRF/length checks protect edits; remark-only writes preserve credentials, active status, sessions and account assignments. Compact billing USER lists omit remarks and password metadata.
- Credit pauses have an explicit marker separate from manual/review stops. Manual and verified FPX credits trigger recovery after their wallet transaction commits; workers retry recovery every five seconds. Recovery verifies current price/balance, active USER/account, grant, pending recipients and absence of unknown/in-flight sends. Manual pause, cancellation, deletion and USER deactivation clear automatic recovery. Identifiable legacy credit pauses migrate once, excluding later manual-stop audit records. No recipient status, schedule or batch counter is reset. Dispatch uses wallet-before-campaign locking; recovery does not lock/reserve wallets, and dispatch always rechecks credit atomically.
- Replaced sequential unconditional polling with parallel page-specific requests, cancellation on navigation, bounded request timeouts and unchanged-data render suppression. Hidden pages/modals/active inputs preserve the existing polling protections. Notice updates and history-sync timestamps no longer rebuild entire tables; horizontal/page scroll is preserved. Message/activity pages use 100-row pagination, with scoped ID queries and supporting indexes.
- Pre-change Railway observations: API CPU peak 0.006, database CPU peak 0.003, worker CPU peak 0.395 in the last-hour sample; 101 sampled HTTP responses were 200. These samples did not indicate resource saturation, so no paid capacity increase was made. They are not a latency/load guarantee for every user or long-term browser operation.
- Syntax passed; ordinary tests: 30 passed, database item skipped there. Disposable PGlite integration: 22 passed, including parent. New/extended tests cover private remark edits, preserved credentials/grants, insufficient/sufficient top-ups, stopped/review/cancelled/deleted tasks, inactive accounts/users and revoked grants, opt-out from automatic recovery, legacy migration, concurrent duplicate adjustments/callbacks, verified FPX resume, no second send, and 100-row page isolation. Native PostgreSQL concurrency and both images are checked by GitHub Actions.
- Chinese/English Owner/USER jsdom checks passed: remark editing/escaping, unchanged heartbeat polls retaining the same DOM and scroll, concurrent request starts, navigation aborting a slow obsolete request, credit-pause labels and manual opt-out, password updates/expiry, safe notice/draft editing and private state clearing on logout. This is controlled DOM/network simulation, not a live browser benchmark.
- No live WhatsApp message, real bank transfer, production USER/remark edit, password reset or data deletion was performed as a test. Actual end-user network/rendering and long-term WhatsApp load require continued target-environment observation.

## 2026-10-12 Owner-only password changes

- USER self-service password changes are disabled. The sidebar button starts hidden and is shown only for Owner; the dialog handler also checks the role. The authenticated password endpoint returns 403 for USER before validating or changing credentials, including requests with the correct current password. Both Chinese and English permission messages are provided.
- Owner continues to reset USER passwords through USER ID management, with CSRF checks and immediate revocation of the target USER's sessions. Owner's own password change still requires the current password and revokes every Owner session. Owner credentials remain excluded from password encryption/reveal responses; USER resets appear in the existing five-minute verified view and refresh hint.
- Syntax checks passed. Ordinary tests: 30 passed, database item skipped there. Disposable PGlite integration: 23 passed, including the parent. Password coverage checks denied USER self-change/direct management requests, unchanged credentials/timestamp/session after denial, CSRF rejection, authorized Owner resets, immediate verified display, old-password rejection and session revocation for USER and Owner. PGlite serializes transactions; native PostgreSQL 17 tests and both container builds are checked separately in GitHub Actions.
- Chinese/English Owner/USER jsdom checks passed: initially hidden sidebar control, role-specific visibility, blocked USER dialog even after manipulating its hidden state, retained Owner reset submission without changing assignments, localized reset hint, Owner self-change and clearing private UI on logout. This is controlled DOM/API simulation, not a real-browser layout check.
- No production password reset, credential reveal, live WhatsApp message, bank transaction or data deletion was performed for testing.

## 2026-10-13 USER balance visibility and direct status management

- USER billing pages show one available-balance card. Message price, reserved holds, hold details, credit ledger and accounting explanations are Owner-only. USER billing responses contain only currency/scale and the signed-in USER's balance/identity, even when another USER ID is requested. Owner retains the full response, rate settings, manual adjustments and hold review. The existing enabled FPX checkout/order flow and maintenance switch remain available under their previous permissions.
- Added an Owner-only Active/Inactive selector to each USER management row and a dedicated status endpoint. Updates validate boolean status, protect Owner IDs, lock the USER before pausing campaigns and write status audit records in the same transaction. Unchanged status requests are idempotent. Credentials, remarks, permissions, grants, account limit and credit are preserved. Deactivation revokes every USER session and pauses tasks without changing recipient states; reactivation permits a new login and leaves paused tasks stopped.
- Dependency install and syntax checks passed. Ordinary tests: 30 passed, database item skipped there. Disposable PGlite integration: 24 passed, including parent; covered minimal USER/full Owner billing with real synthetic holds, cross-USER query isolation, status authorization/CSRF/type checks, protected Owner, session revocation, inactive login denial, preserved data, recipient/task state, idempotent audit and reactivation. The adapter models PostgreSQL bigint response strings but serializes transactions; PostgreSQL 17 concurrency and both images are checked separately in GitHub Actions.
- Chinese/English Owner/USER jsdom checks passed: one USER balance card with minimal and legacy full payloads, hidden management details, balance refresh, FPX on/off and checkout entry, preserved Owner billing controls, protected Owner status, status-only submissions, save/error reversion/retry, disabled pending selector, retained edit dialog and private UI cleanup on logout. This is controlled DOM/API simulation, not a real-browser layout or production-load check.
- No production USER status, password, balance or payment setting was changed as a test. No real payment or live WhatsApp message was sent.

## 2026-10-13 Ledger restoration and separate Status filters

- Restored USER credit-ledger visibility (latest 100 entries) alongside their own balance. USER reads return only ledger display fields, scoped to their signed-in ID; Owner notes/actor details, message price and held totals/details remain absent. Owner keeps the full accounting page. Both roles use the same ledger renderer, and no historical entries are deleted or recalculated.
- Replaced inline row status controls with one read-only ACTIVE / LOCKED / INACTIVE filter above the USER table. Default is ACTIVE; filtering separates rows immediately without mutation requests and preserves selection across navigation, refresh and password viewing within the same login session. Logout clears that preference. Account-state editing stays in the existing Owner dialog.
- Added a distinct locked flag, default false for existing accounts. Owner may create/lock/unlock USERs while their own ID remains protected. Locked/inactive IDs are rejected by login and session reads, payment eligibility, wallet reservation, worker dispatch and credit recovery. Locking revokes sessions and pauses tasks; unlocking does not restart stopped tasks. Existing passwords, grants, credit, WhatsApp sessions and recipient outcomes are preserved. Ledger settlement and verified incoming payments may still complete while access is locked.
- Syntax passed; ordinary tests: 30 passed with the database item skipped there. Disposable PGlite integration: 25 passed, including parent, covering scoped ledger restoration/field omission, protected Owner/CSRF/status validation, distinct lock behavior, login/session/send/recovery denial, migration preserving locks, unlocking, paused tasks and creation of a locked USER. Native PostgreSQL 17 and both image builds are checked separately by GitHub Actions.
- Chinese/English Owner/USER jsdom checks passed: ledger additions/holds/refunds, hidden USER management cards, FPX availability, unchanged Owner controls, three separated filter results, no writes while filtering, refresh persistence, empty categories, edit-state mapping, default creation state and cleanup on logout. This is controlled DOM/API simulation, not a live-browser layout or connection-load check.
- No real USER was locked, unlocked or otherwise edited for testing. No real messages, payments or production data deletions were performed.

## 2026-10-13 mywasap logo and integer credit display

- Replaced loading/login/sidebar branding with the supplied mywasap image and changed application titles. A self-contained SVG embeds the original PNG without modifying its bytes; the default SVG view exposes the emblem for browser icons, with a separate full-logo view on both dashboard and viewer pages. The embedded image's SHA-256 is 0551e57a9e2c022ada72323bbded4ba0f1661c26f7814c0a984e0218cf49ac7d. Sidebar navigation can scroll independently on short screens while the account footer stays accessible.
- USER balance cards, USER ledger movements/balances and Owner USER-management balances display plain stored integer units, e.g. 10000000 for the former RM 1000.0000, without RM, decimal points or grouping separators. USER balances viewed by Owner use the same integer display. Owner ledger/price/hold and FPX currency amounts retain MYR formatting. No stored balance, ledger entry, rate or payment/debit arithmetic is changed; the existing scale remains 10000 units per MYR.
- Syntax checks passed; ordinary tests: 30 passed and the database test skipped locally. Chinese/English Owner/USER jsdom checks passed, including integer zero/positive/negative values, ledger display, branded image/title/icon declarations, preserved Owner monetary details, status filters and session cleanup. Existing PostgreSQL tests and both images continue in GitHub Actions; no new backend logic or database migration was introduced.
- Parsed the SVG, verified embedded PNG bytes against the uploaded logo, and rendered/viewed the full logo and emblem view using Resvg. These are asset/DOM checks, not a real-browser favicon/layout or mobile-device check.
- No real balances, USER credentials/status, bank payments or live WhatsApp sends were used or changed for testing. Only the company-logo attachment is included as an asset; account screenshots are excluded.

## 2026-10-13 透明 Logo 更新

- 使用本次提供的 918 × 918 透明 PNG，原图字样、形状和颜色不变；SVG 内嵌字节与上传文件完全一致（SHA-256：`c05920c3ae51dd2cb8dfca8b91f73e44e2b03e480ccb2268d229dfc327b1a6ce`）。去掉 Logo 样式白底，登录 / 恢复页、侧栏使用完整 Logo，小图标使用同图的图形部分。Logo 与主样式版本地址更新，避免复用旧白底资源。
- SVG 结构和透明通道检查通过；图形 / 全图独立渲染后检查裁切、透明背景和现有深色界面效果。源 PNG 由约 1.58 MB 降至 0.38 MB，SVG 约 0.51 MB。本检查是本地图形渲染，未对生产浏览器逐一验收。
- `npm run check` 通过；普通 `npm test` 为 30 项通过、0 失败、1 项数据库集成跳过（本地未提供 TEST_DATABASE_URL）。临时假 API 的中英文 × Owner / USER 四种 DOM 检查通过，包括 Logo 版本、整数余额 / 流水、状态筛选及权限。后端和资金运算没有改动，未发送真实消息、未操作生产账号。
- 此提交的原生 PostgreSQL 测试与 API / worker 镜像构建由 GitHub Actions 执行；Railway 部署状态单独检查，以对应提交的最终结果为准。
