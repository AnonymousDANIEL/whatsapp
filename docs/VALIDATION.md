# 验证范围 · 2026-10-01

本版本是可部署开发源码，不是已经上线并验收的生产系统。

## 已完成

- JavaScript 语法检查通过。
- 9 项纯函数测试通过：号码校验/规范化/去重、开始和结束边界、跨午夜、停用和日期截止、全天窗口、无效计划拒绝、回执分类、Manager 管理范围、CSV 公式注入防护。
- 1 个综合集成测试通过（内部有多项 HTTP / WebSocket / 数据库断言）：Owner 引导登录、CSRF、Manager/Staff 创建和分配、跨团队访问拒绝、聊天入口来源校验、未登录入口拒绝、联系人批量保存和去重、状态统计、员工停用撤销登录/暂停任务、Manager 停用、审计、号码未注册、已提交/未知发送结果、先到回执保存、回执不降级。
- 集成测试已分别在 **PGlite WASM PostgreSQL** 和 GitHub Actions 的临时 **原生 PostgreSQL 17** 上通过；首次远程运行的原始测试集为 10 项通过、0 项失败、0 项跳过。未验证 Railway 数据库、多个 worker 的互斥与高并发行为。
- 新增 4 项启动诊断测试通过：缺失配置一次列出、真实拒绝连接时保留错误代码、无效 URL 在连接前退出、嵌套异常和循环 cause 中的凭据隐藏。修改前已用关闭的本地 TCP 端口复现只有 `Startup failed:` 的空白日志；修改后明确报告 `ECONNREFUSED`。没有连接生产数据库或真实 WhatsApp。
- 本次本地组合测试为 13 项通过、0 项失败、1 项集成测试跳过（本地未提供 TEST_DATABASE_URL）；远程 PostgreSQL 测试及镜像构建由 GitHub Actions 对本次提交另行执行，结果以对应运行记录为准。
- 浏览器检查通过：实际登录界面、创建号码、Manager/Staff 管理表单、权限分配、创建文字任务、号码去重、结果列表、导航、桌面及移动宽度。测试使用一次性数据，无 WhatsApp 连接，无真实发送。
- 安装锁文件可重现检查通过；生产依赖 npm audit 未发现已知漏洞。该结果不等于整个系统没有安全问题。
- 已加入 GitHub Actions：main 更新后自动使用临时原生 PostgreSQL 运行测试，并构建 API / worker Docker 镜像。首次远程检查的三个任务全部通过：[运行 36850795621](https://github.com/AnonymousDANIEL/whatsapp/actions/runs/36850795621)，对应提交 `f56674941f69d2972fa9f490dd7b2dedfae89bb1`。
- API 与 worker 的最终 Docker 镜像均在 GitHub Actions 成功构建；该检查验证构建步骤，不验证扫码或运行时行为。

## 尚未验证 / 尚未提供

- 未运行最终 worker Docker 镜像验证多 Unix UID、Xvfb、x11vnc 与系统 Chromium 的完整组合。
- 未连接真实 WhatsApp、未测试扫码、真实回执和 WhatsApp 更新后的内部 API 兼容性。
- 未对原版页面进行文件上传、下载、声音、麦克风、视频/音频通话转接；这些功能当前未实现桥接。
- 用户已尝试 Railway 首次部署，提供的日志显示启动失败；尚未核实修复后在 Railway 启动成功，未验证 Railway 私有网络和 WebSocket 端到端连接。
- 未验证 16+ 个号码同时运行的 CPU/内存、连续运行、断网重连、更新部署和备份恢复。
- 源码已上传至 AnonymousDANIEL/whatsapp；后续提交和自动检查以该仓库的实际历史与 Actions 记录为准。

上面的缺项不能由 HTTP 健康检查或纯函数测试替代。正式使用前按 RAILWAY_SETUP.md 的验收步骤逐项验证。
