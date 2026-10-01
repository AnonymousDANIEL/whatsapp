# 后续更新：直接提交 GitHub

目标仓库：https://github.com/AnonymousDANIEL/whatsapp

## 你以后怎么提出更新

在这个对话里直接说明要修改或新增什么，例如：

> 更新 whatsapp 后台：员工名单增加搜索和筛选，检查后直接提交 GitHub。

本项目已记录你的直接上传偏好。GitHub 连接仍有效并具备写入权限时，后续明确提出的修改可以由助手完成代码、检查并提交，不需要你下载 ZIP、复制粘贴或逐个上传文件。每次交付会给出真实的提交链接与检查结果。涉及新增账号服务或需要未提供的配置时，仍需要相应信息。

## 已加入的自动流程

`.github/workflows/verify.yml` 在 main 有新提交、提出 PR 或手动运行时执行：

1. 安装 package-lock.json 锁定的依赖。
2. JavaScript 语法检查。
3. 使用临时 PostgreSQL 运行权限、计划、队列和发送结果测试；不连接真实 WhatsApp、不发送消息。
4. 分别构建管理服务和浏览器 worker 的 Docker 镜像。

GitHub Actions 页面：https://github.com/AnonymousDANIEL/whatsapp/actions

## Railway 自动更新需要首次连接

Railway 的各服务连接此仓库的 main 分支、按 RAILWAY_SETUP.md 配好数据库、浏览器卷和环境变量之后，启用 GitHub Autodeploys。推荐在每个服务启用 **Wait for CI**，让后续代码提交先等 GitHub 检查成功，再开始部署。

Railway 的 Wait for CI 存在平台限制，不能当作强制的所有部署路径检查：CI 工作流必须每次 main 更新都会运行；CLI 或其他部署入口需要另外控制。当前工作流没有路径过滤。

开启方式以 Railway 官方文档为准：
https://docs.railway.com/deployments/github-autodeploys

GitHub 上传成功不表示 Railway 已运行。本仓库不会保存 Railway Token，也没有在 CI 中自动创建收费服务或修改环境变量。

## 更新后的查看位置

| 内容 | 查看位置 |
|---|---|
| 最新源码与提交 | GitHub 仓库 main |
| 自动测试、容器构建结果 | GitHub Actions |
| Railway 构建与运行状态 | Railway Deployments / Logs / Metrics |
| 真正登录、扫码、消息送达 | 部署后的后台与原版 WhatsApp 页面 |

新功能仍由你提出具体要求；这里的自动化是提交后的检查和配置后的部署，不会自行猜测产品需求并改写后台。
