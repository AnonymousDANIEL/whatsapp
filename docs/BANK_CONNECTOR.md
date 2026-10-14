# 银行转账连接与启用

本次提供银行管理、USER 单据充值、完整分页流水和安全入账协议。**尚未安装某家银行或 AutoPay Pro 的适配器，也未连接真实网银**。截图中的账号、密码、网关和流水未作为生产配置或数据导入。要实现自动读取全部 IN / OUT、单据核对和维护状态，需要所用银行 / 网关的正式接口文档与授权；下面的协议用于该服务与本系统之间的适配，不是某家银行原生 API。

Owner：银行管理 → 添加银行 → 填写银行 / 收款户名 / 账号及可选二维码 → 设置状态。银行转账开关默认关闭；Owner 可开启、逐个维护或关闭。USER：银行充值 → 金额 / 银行 → 开始充值 → 按订单金额转账 → 提交 JPG / PNG / WebP 单据（最多 5 MB）。USER 无需填写转账步骤、参考编号、方法、时间或转账人名称。RM 1 仍对应原有 10000 个显示单位，不重新计算旧余额。

没有真实银行接口时，订单保留待核对。Owner 可在银行流水登记已经在银行确认的记录，再在充值单据对应核实入账；人工记录标记 Owner，单独登记不会加 Credit。同一银行交易 ID 必须沿用银行原始 ID，不另造 ID 登记同一笔资金。自动入账只接受连接服务独立验证过的真实记录；这个协议本身不会识别图片真伪，也不会用 OCR 结果代替银行确认。

## 连接服务认证

接入服务为每个银行配置一个至少 32 字符的签名密钥，Owner 保存到相应银行设置。密钥使用 APP_VAULT_KEY 加密，并绑定 bank ID；页面只显示已保存状态。应在实际适配完成后设置密钥，网银登录信息由已授权的银行服务管理，不要作为该密钥填写。不要把银行密码、OTP 或真实单据加入代码仓库。

所有请求使用 HTTPS。请求头：

```text
X-Bank-Timestamp: <UTC Unix seconds>
X-Bank-Signature: <HMAC-SHA256 hex>
```

签名内容为 `timestamp + "." + bank_id + "." + payload_bytes`，有效时间前后五分钟。POST payload 是**原始 JSON 字节**。GET payload 是 UTF-8 `GET /api/banks/feed/<bank_id>/queue`（包括实际请求的查询串），或单据路径。签名绑定银行与请求内容，不使用用户 Cookie 或 CSRF。接口按来源 IP 限流；不要通过用户浏览器调用连接服务接口。

`GET /api/banks/feed/<bank_id>/queue?page=1` 返回当前银行待核对订单，每页 20 条：订单 ID、金额分、单据 SHA-256、MIME、创建 / 截止 / 提交时间。`GET /api/banks/feed/<bank_id>/receipts/<deposit_id>` 返回本银行相应待核对图片。这些接口需要同样的签名。适配服务应分页处理全部待核对订单，读取已授权银行 API，验证实际到账和单据归属，不能只按金额认领别人的转账。

## 银行流水与核对通知

`POST /api/banks/feed/<bank_id>`，样例全部为合成数据：

```json
{
  "version": 1,
  "live": true,
  "event_id": "01234567-89ab-4cde-8123-0123456789ab",
  "account_number": "1234567890",
  "maintenance": false,
  "balance_cents": 123450,
  "transactions": [
    {
      "id": "provider-original-transaction-id",
      "direction": "in",
      "status": "posted",
      "amount_cents": 5000,
      "occurred_at": "2026-10-14T15:30:00+08:00",
      "description": "Synthetic bank entry",
      "reference": "synthetic-bank-reference"
    }
  ],
  "decisions": [
    {
      "deposit_id": "abcdef01-2345-4abc-8123-0123456789ab",
      "receipt_sha256": "64-character-lowercase-sha256",
      "status": "matched",
      "transaction_id": "provider-original-transaction-id"
    }
  ]
}
```

示例 hash 是占位符，必须换成实际 queue 返回的 64 位 hash；示例时间必须换成真实交易时间。每批最多 500 条流水及 100 项核对；余额可为空，未提供时页面显示空值。Out 流水使用 `direction: "out"`，只用于 Owner 查看，不会执行银行提款。必须提供稳定的原始交易 ID，重放相同 event ID 必须使用完全相同的 JSON 字节。已有交易的方向 / 金额 / 时间 / 银行参考编号不能被覆盖。每个原始交易仅能绑定一次充值；已确认 Owner 记录的同 ID 可在原始数据一致时由服务独立验证。

`matched` 需要准确关联订单、当前单据 hash 和真实银行交易。只按金额、一个用户提交的任意参考编号或 OCR 文本不够；适配器必须能够验证付款归属，缺少可靠关联时留下待核对供 Owner 审核。自动流程再检查 IN、金额相等、发生时间在订单创建前五分钟至创建后 24 小时之间、未被其他订单使用。较晚提交的单据保留待核对；Owner 明确确认银行流水对应后可人工处理超时付款，仍须真实 IN、金额一致且交易未被使用。钱包、订单、银行交易和余额流水原子更新，重复通知不会重复加 Credit。入账后沿用余额暂停恢复规则；停用、锁定、手动暂停或待核对任务不会因入账开始。

`invalid` 表示服务已独立确认当前单据无效；相应订单显示拒绝原因。没有查到交易使用 `no_match`，省略 transaction_id：在付款窗口尚未结束、数据缺失、网络失败或银行维护期间，系统仍保留等待。仅在完整覆盖已关闭窗口时才最终拒绝：

```json
"coverage": {
  "complete": true,
  "from": "2026-10-13T15:25:00+08:00",
  "to": "2026-10-14T15:30:00+08:00"
}
```

from 必须不晚于该订单创建前五分钟，to 必须覆盖截止时间；全部流水必须从可信接口读取完成。适配器不能将 API 错误、部分分页、OCR 失败或未知结果伪装成完整覆盖。

## 关闭与维护

维护可由 Owner 手动设置，或由签名银行服务通知 `maintenance: true`。关闭银行转账系统 / 某个银行后，USER 看不到该银行与二维码，服务器拒绝新订单；已经创建且付款的订单仍允许补交单据并核实入账。关闭不删除原始记录，也不屏蔽有效银行结算通知。FPX 是原独立充值渠道，继续使用原开关。

生产验收须连接实际银行服务，核对完整 IN / OUT 数据、分页、到账延迟、维护恢复、付款归属及权限。模拟测试不能证明实际银行连接已完成。
