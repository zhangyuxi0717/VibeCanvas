# VibeCanvas 数据流向说明

这份文档讲清楚三件事：**哪些数据会离开服务器、作品和图片存在哪里、怎么删掉。**
写给部署和试用组织者看，也可以直接拿给试用用户看。文中只描述代码实际的行为，
不涉及任何合规认证或法律结论——那部分需要你自己找专业人士出文本。

## 1. 总览

```
浏览器 ──主题/文案──▶ 本服务 ──▶ 文本模型服务（图片描述翻译也走这里）
   │                    │
   ├──照片─────────────▶├──────▶ 视觉模型服务（只发这一次，服务端不留）
   │                    │
   └──配图任务─────────▶├──────▶ 图片模型服务 / 本机 ComfyUI
                        │
                        ├──▶ data/image-tasks.json      任务记录（含英文配图提示词）
                        ├──▶ data/generation-assets/    生成的配图文件
                        ├──▶ data/events/               产品事件
                        └──▶ data/feedback/             用户反馈文本

浏览器 IndexedDB  ← 作品（文字 + 图片 Blob）默认只存在这里
        │
        └──用户点「同步到云端」──▶ Supabase：Postgres(作品 JSON) + 私有 Storage(图片)
```

## 2. 会发给第三方模型服务的数据

发往哪个服务，由**部署时填的地址决定**，代码本身不绑定任何一家厂商。

| 数据 | 发到哪个配置项 | 什么时候发 | 说明 |
| --- | --- | --- | --- |
| 活动主题、用户输入的标题/正文/标签 | `MODEL_API_URL` | 每次点「生成」 | 纯请求体，服务端不落盘 |
| 照片 | `VISION_API_URL` | 只有「上传照片」模式 | 服务端用 sharp 校验并缩到最长边 1600px、转 JPEG(质量 85) 后以 base64 发出；**不写入磁盘，不写日志**，请求结束即从内存释放 |
| 中文配图描述 | `MODEL_API_URL` | 用户改了配图描述后重新生成配图 | 只是翻译成英文提示词，不消耗图片额度 |
| 英文配图提示词 | `IMAGE_API_URL`，或本机 ComfyUI `COMFYUI_API_URL` | 点「AI 配图」 | ComfyUI 在本机时不出这台机器 |

模型服务的处理方式、保留期限和计费规则由该服务商决定，不在本项目的控制范围内。
选服务商时请自己看对方的条款。

登录邮件由 Supabase Auth 发送，邮箱地址保存在 Supabase 的 `auth.users` 里，
本服务不单独保存邮箱，只在校验会话时读取。

## 3. 存在服务器上的数据

全部在 `DATA_DIR` 下（生产环境是 `/var/lib/vibecanvas/data`）。

| 文件 | 内容 | 谁会写 |
| --- | --- | --- |
| `image-tasks.json` | 每个配图任务的 id、幂等键、**英文提示词**、归属（登录用户 id，或未登录时的 `guest:<访问 IP>`）、状态、额度记录 | 配图任务执行器 |
| `generation-assets/<taskId>.bin` | 生成好的图片原始字节 | 配图任务执行器 |
| `events/events-YYYY-MM-DD.jsonl` | 白名单事件名 + 枚举/数字属性 + 匿名 id + 版本号 + 时间 | `/api/events` |
| `feedback/feedback-YYYY-MM-DD.jsonl` | 评分(1–5)、反馈文本（最多 300 字）、12 位随机来源号、时间 | `/api/feedback` |

注意事项：

- `image-tasks.json` 里的提示词是模型生成的英文描述，不是用户正文；但它由用户的主题衍生而来，
  删数据时要一起考虑。
- 未配置 Supabase 时，配图任务用 `guest:<IP>` 记归属——这意味着数据文件里有访问 IP。
  一旦配置了 Supabase 并强制登录，归属就变成用户 id，不再写 IP。
- 服务日志（journald / 控制台）只有请求次数、耗时、结果状态、供应商请求 id 和用量数值，
  不记录提示词、图片、正文或密钥。

## 4. 存在浏览器上的数据

| 位置 | 内容 |
| --- | --- |
| IndexedDB `vibecanvas-works` | 作品记录和图片 Blob（含用户上传的原图） |
| localStorage `vibecanvas-active-work` | 最近打开的作品 id |
| localStorage `vc-anon-id` | 随机匿名 id，只用于把同一浏览器的多次事件串起来，不含任何可识别信息 |

浏览器数据只在当前站点地址下有效：换端口、换域名、清缓存、无痕模式都会看不到原来的作品。

## 5. 存在 Supabase 上的数据

只在配置了 `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 并且用户登录后才有。

| 位置 | 内容 |
| --- | --- |
| `auth.users` | 邮箱；Supabase 自己管密码/登录链接 |
| 表 `cloud_works` | 作品 JSON（标题、正文、标签、排版、图片在 Storage 的路径）、`user_id`、`revision`、时间 |
| 私有 bucket `vibecanvas-private` | 图片文件，路径 `{user_id}/{work_id}/{asset_id}` |

行级安全（RLS）按 `user_id` 隔离；图片是私有 bucket，浏览器拿到的是**10 分钟有效期**的签名链接，
过期后要重新请求。服务端用 service role key 访问，这个 key 只放在服务器的 `.env` 里。

## 6. 保留多久

| 数据 | 保留 |
| --- | --- |
| 配图任务与图片文件 | 任务结束（完成/失败/取消/状态未知）后 30 分钟由服务自动清理（`ttlMs` 默认 30 分钟） |
| 事件 / 反馈 JSONL | 不自动删除；单日文件超过 50 MB 后当天不再写入。需要按自己的保留期手工归档或删除 |
| 浏览器 IndexedDB | 用户自己删作品或清缓存；没有服务端过期机制 |
| Supabase 数据 | 不自动删除，由项目所有者管理 |

## 7. 怎么删除数据

### 用户自己能做

- **删单个作品**：作品库里点删除。本地 IndexedDB 里那条立即删掉；如果同步过云端，会同时删
  `cloud_works` 那一行和对应的 Storage 图片（`DELETE /api/cloud/works/:id`，先校验归属）。
- **删全部本地数据**：清浏览器该站点的数据。
- **删云端账号**：Supabase 里删 `auth.users` 那一行，并删掉 `cloud_works` 里 `user_id` 相同的行
  以及 `vibecanvas-private/{user_id}/` 目录（数据库里的外键或 RLS 不会自动帮你删 Storage）。

### 组织者要做的

```bash
# 停服务后直接删对应文件，按日期或按任务
rm data/generation-assets/<taskId>.bin
# 事件和反馈按天切分，删整天最省事
rm data/events/events-2026-10-30.jsonl data/feedback/feedback-2026-10-30.jsonl
```

删 `data/image-tasks.json` 会把所有任务记录和额度计数一起清掉。**服务运行中不要直接改这个文件**，
先停服务；否则内存状态会在下次写入时把它覆盖回去。

## 8. 明确不收集的东西

- 不记录用户输入的标题、正文、标签、配图描述到事件或日志；
- 不记录照片本身，服务端只在内存里处理一次；
- 事件属性只接受白名单里的枚举值和数字，其余字段在服务端被丢弃（有测试覆盖：
  往事件里塞 `prompt` 和 `email` 会被丢掉）；
- 反馈记录里不写 IP；事件接口按 IP 限流，但 IP 本身不进事件文件；
- 没有接入任何第三方统计、广告或埋点 SDK，前端不加载外部脚本（CSP 为 `script-src 'self'`）。

## 9. 需要你自己补的东西

下面这些代码不做，也不该由代码替你决定：

- 面向试用用户的隐私说明和用户协议文本（本文档描述的是事实，不是法律文本）；
- 所接入模型服务商的数据处理条款、是否需要备案与等保评估；
- 如果以后要处理未成年人的照片或可识别个人信息，需要另行评估；
- Supabase 项目所在地域（数据存储在哪个区域）由你在创建项目时选择。

## 10. 本文档里哪些是核实过的

- 第 3 节的字段来自实际读取 `data/image-tasks.json`（含 `prompt` 字段）和 `telemetry.js` 白名单；
- 第 7 节的云端删除逻辑对应 `server.js` 的 `DELETE /api/cloud/works/:id`，会先校验归属再删行和图片；
- 事件接口丢弃非白名单属性、反馈不写 IP，均由 `trial-guard.test.js` 断言；
- 签名链接 10 分钟有效期来自 `cloud-store.js` 的 `expiresIn: 600`。
- **未核实**：真实 Supabase 项目上的删除效果（本机没有可用项目，未对线上执行删除）。
