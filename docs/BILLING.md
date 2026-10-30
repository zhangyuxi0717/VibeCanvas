# 付费闭环：一次性购买生成额度

这份文档说明 VibeCanvas 目前唯一的付费形态：**用户买一个额度包，扣完为止**。
没有订阅、自动续费、优惠券、分销和会员等级。

当前默认 `BILLING_ENABLED=false`。打开之前请先读完第 8 节「开启真实收款前要确认的事」。

---

## 1. 一句话结构

```
浏览器下单（只传商品 id）
   → 服务端按商品表定价、建订单、向渠道要支付链接
   → 用户在渠道完成支付
   → 渠道异步通知 / 服务端主动查单
   → 验签、核对金额币种订单归属支付状态
   → 订单标为已支付，写一条不可变的 purchase 流水
   → 每生成一张配图：预占 1 额度，成功记消耗，失败/取消退回
```

额度余额不是一个存起来的数字，而是把 `ledger.jsonl` 从头重放算出来的。
重复通知、重启、查单和通知同时到达，都只会发一次额度。

---

## 2. 文件与数据

| 文件（在 `DATA_DIR/billing/` 下） | 内容 | 能否删 |
| --- | --- | --- |
| `ledger.jsonl` | 额度流水，只追加 | **不能**。删了余额和历史就没了 |
| `orders.json` | 订单状态、金额、退款记录 | 不能 |
| `accounts.json` | 匿名账户（id、创建时间、IP） | 不能 |
| `audit.jsonl` | 运营操作与通知处理记录 | 建议长期保留 |
| `mock-trades.json` | 模拟渠道的交易记录 | 只在 mock 渠道下存在，可删 |
| `runtime.json` | 「暂停生成」开关 | 可删，删了等于恢复 |
| `account-secret` | 开发环境自动生成的账户签名密钥 | 删了所有浏览器凭证失效，额度还在但用户找不回账户 |

备份方式与 `DATA_DIR` 其它数据相同，见 `docs/DEPLOY.md` 的备份与恢复章节。
`ledger.jsonl` 与 `orders.json` 必须一起备份，否则恢复后可能出现「订单已支付、流水里没有 purchase」。

---

## 3. 配置

### 3.1 商品、额度与有效期

商品表只认环境变量 `BILLING_PRODUCTS`（JSON 数组），不存在内置价格。

```bash
BILLING_PRODUCTS=[{"id":"starter","title":"体验包","priceFen":990,"credits":30,"creditValidDays":90,"description":"30 张 AI 配图额度，90 天内有效"}]
BILLING_CREDITS_PER_TASK=1
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 小写字母、数字、短横线，2–32 位，不能重复 |
| `title` | 是 | 1–40 字，显示在支付页和订单里 |
| `priceFen` | 是 | 整数，单位「分」，1–1 000 000（即 0.01–10 000 元）；也可写 `priceYuan` |
| `credits` | 是 | 整数，1–100 000 |
| `creditValidDays` | 否 | 0–3650，0 表示长期有效；不写默认 0 |
| `description` | 否 | 最多 120 字，显示在购买面板 |

`BILLING_CREDITS_PER_TASK` 是每张 AI 配图扣多少额度，默认 1，上限 100。
改价格、改额度都只改环境变量再重启，不需要改代码。

### 3.2 账户凭证

没有登录体系。用户第一次打开「额度与订单」时，服务端生成一个账户 id，
并用 `BILLING_ACCOUNT_SECRET` 做 HMAC 签名，返回给浏览器保存。

- 生产必须显式设置，至少 32 个字符：`openssl rand -hex 32`。
- 开发环境留空时自动生成 `DATA_DIR/billing/account-secret`。
- 换了密钥，所有已发出的凭证立即失效；用户会拿到一个新账户，旧额度还在但关联不上，
  **换密钥前先确认没有未使用的付费额度**。
- 清浏览器缓存、换设备、换浏览器，都会丢凭证。这是无登录体系的代价，界面上已写明。
  需要跨设备找回，就得先做账号体系，不在本次范围内。

### 3.3 运营凭证

```bash
ADMIN_TOKEN=            # openssl rand -hex 24；留空则 /api/admin/* 全部 404
```

运营接口用请求头 `X-Admin-Token`，与用户额度凭证完全分开。
可选再传 `X-Admin-Actor: 姓名或工号`，会写进审计日志的 `actor` 字段。

### 3.4 模拟渠道（本地与演练）

```bash
BILLING_ENABLED=true
BILLING_PROVIDER=mock
BILLING_PRODUCTS=[...]
BILLING_ACCOUNT_SECRET=至少32个字符
ADMIN_TOKEN=至少16个字符
```

`mock` 渠道提供一个「模拟支付 · 不会真实扣款」的收银台，走的路径与真实渠道相同：
下单 → 收银台 → 服务端收到带 HMAC 签名的通知 → 验签 → 发货。
生产环境配置为 `mock` 会直接拒绝启动。

### 3.5 支付宝沙箱

在支付宝开放平台创建应用、开通「电脑网站支付」，使用沙箱应用拿到 APPID 和密钥。
支付宝的验签规则、参数名和查单接口以开放平台当前的「电脑网站支付」文档为准
（开放平台文档中心：`https://opendocs.alipay.com/`），这里只写本项目需要填什么。

```bash
BILLING_PROVIDER=alipay
ALIPAY_APP_ID=你的沙箱APPID
ALIPAY_PRIVATE_KEY_PATH=/etc/vibecanvas/alipay-app-private.pem   # 应用私钥，PKCS8
ALIPAY_PUBLIC_KEY_PATH=/etc/vibecanvas/alipay-public.pem         # 支付宝公钥，不是应用公钥
ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do
ALIPAY_NOTIFY_URL=https://你的域名/api/billing/notify/alipay
ALIPAY_RETURN_URL=https://你的域名/
ALIPAY_SELLER_ID=            # 可选，填了会校验
```

要点：

- 私钥、公钥放服务器文件，权限 600，属主是服务运行用户；不要写进仓库、不要贴进聊天记录。
- `ALIPAY_NOTIFY_URL` 必须是支付宝能从公网访问的 **https** 地址。
  本机开发要用隧道（见 `docs/TRIAL.md` 第 6 节），否则收不到异步通知，
  只能靠用户点「查单」确认。
- 支付宝通知是 `application/x-www-form-urlencoded`，服务端按原样参数验签，
  验签用的是「除去 `sign`、`sign_type`、空值后按参数名排序拼接」的原文。
- 查单接口的响应也是验签后才采信；只把 `ACQ.TRADE_NOT_EXIST` 当成「还没付」，
  其它错误不会当成支付成功。
- 支付成功跳转页不参与发货。用户从支付宝回到站点时，页面只是带着订单号去查单。

---

## 4. 额度规则

| 场景 | 额度怎么变 |
| --- | --- |
| 购买成功 | 新增一个批次，`credits` 张，按 `creditValidDays` 到期 |
| 新账户赠送（默认 0） | 同上，按 `BILLING_SIGNUP_GRANT_VALID_DAYS` 到期 |
| 发起配图 | 预占 `BILLING_CREDITS_PER_TASK` 张，可用额度减少、已预占增加 |
| 生成成功 | 预占转为消耗，不再退回 |
| 生成失败 / 用户取消 | 预占原路退回对应批次，可用额度恢复 |
| 供应商状态不确定 | 先保留预占；超过 `BILLING_UNCERTAIN_HOLD_MINUTES`（默认 30）后自动释放 |
| 服务重启 | 启动对账：已完成补记消耗，失败/取消/任务丢失退回，不确定超时退回 |
| 批次到期 | 剩余额度归零，记一条 `expire` 流水 |
| 运营调整 | 正数新增批次，负数从最早到期的批次扣；扣不够记 `shortfall` |
| 订单退款 | 只收回该订单批次里**还没用掉**的额度；已消耗部分记 `shortfall`，不追扣 |

消耗顺序：先到期先扣。同一账户有多个批次时，快过期的先用。

### 生成失败、状态不确定、退款

- **生成失败**：任务状态 `failed`，预占释放，用户额度回到原样。
- **状态不确定**：请求已发给图片服务但没有拿到确定结果（超时、连接中断）。
  任务标为 `uncertain`，额度保留；用户可以在界面上看到「状态不确定，可重试」。
  保留时间到后自动释放，即使供应商后来真的出了图，也不会再扣。
- **退款**：额度由本项目收回，钱由支付宝商家后台退。运营在 `/api/admin/orders/:单号/refund`
  登记退款后，订单变为 `refunded`，该订单未使用的额度被收回。
  如果用户已经用掉一部分，缺口写入订单的 `refund.shortfall`，需要人工决定是否追补。
  重复登记退款返回第一次的结果，不会重复扣。

---

## 5. 接口

用户侧（需要 `X-Billing-Token`，账户接口除外）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/billing/config` | 商品表、每任务额度、是否暂停 |
| POST | `/api/billing/account` | 创建或复用额度账户，返回凭证与余额 |
| GET | `/api/billing/wallet` | 可用、已预占、批次、最近 30 条流水 |
| GET | `/api/billing/usage` | 使用记录 |
| POST | `/api/billing/orders` | 传 `{productId}`，金额由服务端决定 |
| GET | `/api/billing/orders` | 我的订单 |
| GET | `/api/billing/orders/:单号` | 订单详情 |
| GET | `/api/billing/orders/:单号?refresh=1` | 主动查单，以渠道结果为准 |

渠道回调：`POST /api/billing/notify/alipay`、`POST /api/billing/notify/mock`，返回纯文本 `success` / `failure`。

运营侧（需要 `X-Admin-Token`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/orders?status=&limit=` | 查订单 |
| GET | `/api/admin/orders/:单号` | 单笔详情（含账户 id、渠道交易号） |
| POST | `/api/admin/orders/:单号/refund` | `{reason}`，收回未用额度并记审计 |
| GET | `/api/admin/tasks?limit=` | 最近的配图任务 |
| POST | `/api/admin/pause` | `{paused:true,reason}` / `{paused:false}` |
| POST | `/api/admin/credits/adjust` | `{accountId,credits,reason}`，可正可负 |
| GET | `/api/admin/audit?limit=` | 审计日志 |
| GET | `/api/admin/accounts/:账户id` | 账户、余额、订单 |

鉴权失败也会写审计（`admin_auth_failed`）。暂停生成对 `/api/image-tasks`、`/api/image-prompt`、
`/api/generate` 同时生效，返回 `503 GENERATION_PAUSED`。

---

## 6. 测试与验证结果

```bash
npm test          # 108 项，其中 26 项是付费闭环
npm run build
```

`billing.test.js` 覆盖的场景，全部在当前代码上实际跑过：

| 场景 | 做法 | 结果 |
| --- | --- | --- |
| 重复通知 | 同一份已验签通知连续处理两次 | 第二次 `already=true`，额度只发一次 |
| 通知金额被篡改 | 改 `total_amount`，签名随之失效 | 验签失败，不发货 |
| 签名有效但金额不符 | 用真密钥签一条 0.01 元的通知 | 拒绝，订单保持 `pending` |
| 未知订单 / 错误 `app_id` | 伪造通知 | 拒绝，不发货 |
| 并发扣减 | 5 额度账户并发预占 20 次 | 5 成功、15 拒绝，余额不为负 |
| 支付超时 | 订单 1 分钟有效，时钟前进 2 分钟 | 订单关闭；迟到的真实通知仍正确发货 |
| 退款 | 买 3 用 1 后退款 | 收回 2，`shortfall=1`；重复退款不重复扣 |
| 订单越权 | 用 B 的凭证查 A 的订单 | 404 |
| 运营越权 | 不带/带用户凭证访问 `/api/admin/*` | 401 |
| 生成失败 / 取消 | 任务回调 `failed` / `cancelled` | 预占退回 |
| 重启对账 | 新进程按任务状态对账 | 已完成补消耗、任务丢失退回 |
| 不确定超时 | `uncertain` 超过保留时间 | 自动释放 |
| HTTP 全流程 | 开户 → 下单 → 模拟收银台 → 查单 → 配图 | 额度 3 → 生成后 2 |
| 配置校验 | 生产 + mock、非法商品表 | 拒绝启动，错误信息逐条列出 |
| 支付宝签名 | 临时 2048 位 RSA 密钥对，签下单参数、通知、查单响应 | 签名可验；改金额、改节点、缺签名都被拒绝 |

**没有做的验证**：真实支付宝沙箱的完整付款流程没有跑过。
原因是没有沙箱应用、APPID 和密钥，也没有可被支付宝回访的固定 https 域名。
代码里的支付宝签名、验签、查单只用临时 RSA 密钥做过单元级签名/验签往返，
没有和支付宝真实网关交互。开启真实收款前，必须按第 7 节在沙箱里补跑一遍。

---

## 7. 沙箱验证清单（切换 alipay 后逐项打勾）

1. `npm run check:config` 无错误；确认 `ALIPAY_GATEWAY` 是沙箱地址。
2. 在沙箱买家账号下买最便宜的商品，确认跳转、支付、回到站点都正常。
3. 支付宝后台能看到异步通知成功；服务端日志出现 `billing_notify_accepted`。
4. 把通知地址临时改错，确认订单不会自己变成已支付，点「查单」能补上。
5. 同一订单手动重放通知（可用 mock 渠道模拟），确认额度不重复。
6. 沙箱后台对订单退款，再在 `/api/admin/orders/:单号/refund` 登记，确认额度按规则收回。
7. 用两个浏览器确认订单互不可见。
8. 暂停生成后确认新配图被拒，恢复后正常。
9. 备份 `DATA_DIR/billing/`，在另一台机器恢复，确认余额与订单一致。

支付宝沙箱的买家账号、卖家账号、APPID、密钥都在开放平台的「沙箱」页面获取，
不在本项目仓库里。

---

## 8. 开启真实收款前要确认的事

这些动作会产生真实影响或费用，做之前需要你逐项确认：

1. **支付宝商户资质与签约**：企业/个体工商户主体、开通「电脑网站支付」。
   费率以签约时的支付宝合同为准（常见为按笔收取一定比例，具体数字以合同为准，本文件不代填）。
2. **域名与备案**：`ALIPAY_NOTIFY_URL` 必须是已备案域名下的 https 地址；
   用 Cloudflare 临时隧道只能做沙箱演练，不能作为正式回调地址。
3. **价格与额度**：`BILLING_PRODUCTS` 里的价格、额度、有效期是最终对用户展示的内容，
   一旦有人付款就不能悄悄改；要改就新增商品 id。
4. **退款流程**：本项目只收回额度，钱要在支付宝商家后台退；
   谁有权限、多久内处理、已消耗额度怎么算，需要先定下来。
5. **客服与发票**：用户付款后怎么联系、是否开票、开票主体是谁。
6. **密钥保管**：`BILLING_ACCOUNT_SECRET`、`ADMIN_TOKEN`、支付宝私钥只放服务器；
   换密钥会让已发出的额度凭证失效。
7. **对账**：每天至少看一次 `orders.json` 里 `paid` 但没 `purchase` 的记录（正常应为 0），
   以及 `audit.jsonl` 里的 `notify_rejected`。
8. **限额**：目前是单进程内存队列，不支持多实例。开收款前评估并发量，
   超出现有容量要先做外部队列或拆服务。

---

## 9. 单次生成成本

试用记录里能确认的事实：

- 配图：一次请求生成一张 768×1024 PNG，文件 757 KB；经 Cloudflare 隧道往返耗时 0.9–2.7 秒
  （`docs/TRIAL.md` 6.1）。
- 文字生成：试用事件只记录了成功/失败次数，**没有记录 token 用量**。

因此：

- **文字生成的单次成本：未知。** 没有输入/输出 token 数，也没有供应商账单，
  无法给出可信金额。要得到这个数，需要在模型服务侧打开用量日志，
  按「输入 token × 单价 + 输出 token × 单价」计算。
- **配图的单次成本：未知。** 本地 ComfyUI 只有电费和机器折旧；
  换成云端图片 API 后按供应商价目表 × 张数计算，本项目没有内置任何价格。

定价前请先用真实账单算出「每张配图成本」和「每次文字生成成本」，
再决定 `credits` 与 `priceFen`。本文件不提供利润率估算。
