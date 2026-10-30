# VibeCanvas 试用版部署手册

本文写给「要把这套东西放到一台服务器上，给几个人用」的场景。
所有命令都在项目根目录执行；带 `sudo` 的地方在 Linux 服务器上执行。

## 1. 选了什么部署方式，为什么

VibeCanvas 是一个 Node 单进程服务：

- 前端是构建出来的静态文件（`public/`），由同一个进程托管；
- 文本、视觉、配图三类模型调用都由服务端发出，密钥不出服务器；
- 配图任务、生成结果、产品事件写在 `DATA_DIR` 里的普通文件上；
- 云端账号与云同步是**可选项**，没配 Supabase 时作品只存在用户浏览器本地。

所以最贴合它的形态是「**一台小服务器 + 持久数据盘 + 反向代理终止 TLS**」：

| 方案 | 适合 | 说明 |
| --- | --- | --- |
| Linux 小服务器 + Caddy | 小范围试用（推荐） | 单进程、单目录，备份就是打包一个目录；Caddy 自动管证书 |
| 本机 Windows + Cloudflare Tunnel | 只想让两三个人看 | 不用买域名和服务器，隧道给一个临时域名；关机即停 |
| 容器编排 | 现阶段不需要 | 只有一个进程，加了反而多一层要维护的东西 |

**不推荐**把 `DATA_DIR` 放在容器临时层、`/tmp` 或系统临时目录——重启就丢配图任务和事件。
生产模式启动时会检查这一点并直接拒绝启动。

## 2. 需要的东西和费用

以下都是**需要我确认后才能创建**的资源。价格仅为大致区间，以各家官网下单页为准。

| 项目 | 是否必须 | 大致费用 | 说明 |
| --- | --- | --- | --- |
| 云服务器（2 核 2G，Linux） | 必须 | 约 ¥60–100 / 月 | 轻量应用服务器即可；需要一块数据盘或至少 20G 系统盘 |
| 域名 | 有域名才需要备案 | 约 ¥30–60 / 年 | `.cn` 需实名 |
| ICP 备案 | 用国内服务器 + 域名时必须 | 免费，约 3–4 周 | 未备案不能用 80/443 对外提供网站 |
| TLS 证书 | 必须 | 0 | Caddy 自动申请 Let's Encrypt |
| Supabase 项目 | 可选 | 免费档通常够用，超出按官网计费 | 只有需要「登录 + 云同步 + 云端作品」时才建 |
| 模型 API | 必须 | 按量计费 | 文本、视觉、配图三套密钥，建议各自设额度上限 |

如果不想买服务器和域名，走「本机 + Cloudflare Tunnel」这条路，费用为 0，代价是电脑关机服务就停。

## 3. 服务器首次部署

### 3.1 系统准备

```bash
sudo adduser --system --group --home /opt/vibecanvas vibecanvas
sudo mkdir -p /opt/vibecanvas /var/lib/vibecanvas/data
sudo chown -R vibecanvas:vibecanvas /opt/vibecanvas /var/lib/vibecanvas
# Node.js 20 或更新版本
node -v
```

### 3.2 上传代码并构建

在开发机上构建好再传，也可以在服务器上构建（需要联网装依赖）：

```bash
# 开发机：打包需要上传的内容（node_modules 可以不传，服务器上 npm ci --omit=dev）
tar -czf vibecanvas-$(date +%Y%m%d).tar.gz \
  --exclude node_modules --exclude public --exclude data --exclude .env* \
  --exclude backups --exclude .tmp-test-data .
```

```bash
# 服务器
cd /opt/vibecanvas && tar -xzf ~/vibecanvas-20261030.tar.gz
sudo -u vibecanvas npm ci            # 构建依赖也算在内
sudo -u vibecanvas npm run build     # 产出 public/
sudo -u vibecanvas npm ci --omit=dev # 只留运行依赖（sharp）
```

`public/` 不进版本库，每次部署都必须跑一次 `npm run build`。

### 3.3 配置

```bash
sudo -u vibecanvas cp .env.production.example .env.production
sudo -u vibecanvas chmod 600 .env.production
sudo -u vibecanvas nano .env.production      # 逐项填
```

必填：`APP_ORIGIN`（https 开头，和浏览器地址栏一致）、三个模型服务的 URL / 模型名 / 密钥、
`TRIAL_ALLOWED_EMAILS`、`DATA_DIR=/var/lib/vibecanvas/data`、`STATIC_ROOT=/opt/vibecanvas/public`。

改完先自检，它会打印「会怎么跑」和「缺什么」，不会启动服务，也不会打印密钥：

```bash
sudo -u vibecanvas node --env-file=.env.production scripts/check-config.js
```

生产环境里，以下任意一条不满足都会拒绝启动：`APP_ORIGIN` 缺失或不是 https、
没有 `public/index.html`、`DATA_DIR` 在系统临时目录、既没证书也没声明 `BEHIND_TLS_PROXY=true`、
试用名单为空却没设 `TRIAL_OPEN=true`、名单人数超过 `TRIAL_MAX_USERS`。

### 3.4 HTTPS

两条路，选一条：

**A. 反向代理终止 TLS（推荐）**

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # 先把里面的域名改掉
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

`.env.production` 里保持 `BEHIND_TLS_PROXY=true`、`TRUST_PROXY=true`，`PORT=8080`、`HOST=127.0.0.1`。

**B. Node 自己上 HTTPS**

证书放到 `/etc/vibecanvas/`，`.env.production` 里填 `TLS_CERT_PATH`、`TLS_KEY_PATH`，
并去掉/注释 `BEHIND_TLS_PROXY`。

### 3.5 启动

```bash
sudo cp deploy/vibecanvas.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vibecanvas
sudo systemctl status vibecanvas
sudo journalctl -u vibecanvas -f
curl -k https://你的域名/healthz
curl -k https://你的域名/readyz
```

`/healthz` 只回进程还活着；`/readyz` 会真的检查静态产物在不在、数据目录能不能写、数据库通不通，
返回 503 就是还不能接流量。

### 3.6 安全默认值（已生效，不需要逐项配置）

- **不使用 Cookie。** 服务端不种任何 Cookie，登录态是浏览器把 Supabase 会话放进
  `Authorization: Bearer`，所以不存在基于 Cookie 的 CSRF 面。`X-Frame-Options: DENY` 同时禁止被嵌进 iframe。
- **CORS / 来源校验：** 只接受同源和 `APP_ORIGIN`；非生产环境额外放行 `127.0.0.1` / `localhost` 的任意端口，
  方便本地换端口调试。生产环境不会放宽。
- **响应头：** `Content-Security-Policy`（脚本只允许本站）、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: no-referrer`、`Permissions-Policy` 关闭定位/麦克风/摄像头、跨源隔离头；
  HTTPS 下由 Node 自己发 HSTS（反代模式交给 Caddy）。
- **请求体上限：** 事件与反馈 16 KB、配图任务 8 KB、云端作品 12 MB、单张图片 8 MB；
  超限直接 413，不读进内存。
- **静态文件白名单：** 只放行 `app.js`、`app.css`、`build.json`、`work-library.js`、
  `image-prompts.js`、`favicon.svg` 和 `index.html`。`/.env`、`/server.js`、`/package.json` 一律 404。
- **错误响应：** 5xx 只回一句通用提示和一个 `requestId`，堆栈只进服务日志。

## 4. 上线后每次改动怎么升级

```bash
# 1. 备份（先备份再动代码）
sudo -u vibecanvas DATA_DIR=/var/lib/vibecanvas/data bash scripts/backup-data.sh /var/backups/vibecanvas

# 2. 停服务、换代码、装依赖、构建
sudo systemctl stop vibecanvas
# ...解压新版本到 /opt/vibecanvas...
sudo -u vibecanvas npm ci && sudo -u vibecanvas npm run build && sudo -u vibecanvas npm ci --omit=dev

# 3. 起服务并确认就绪
sudo systemctl start vibecanvas
curl -k https://你的域名/readyz
```

`public/index.html` 里的 `?v=<hash>` 会在内容变化时自动变，用户不用清缓存。

## 5. 回滚

回滚 = 换回上一份代码 + 上一份数据。

```bash
# 代码：保留每次上传的 tar 包，直接换回来
sudo systemctl stop vibecanvas
sudo mv /opt/vibecanvas /opt/vibecanvas.broken-$(date +%Y%m%d%H%M)
sudo mkdir -p /opt/vibecanvas && tar -xzf ~/vibecanvas-20261029.tar.gz -C /opt/vibecanvas
sudo -u vibecanvas npm ci --omit=dev
sudo systemctl start vibecanvas

# 数据：只有新版本把数据写坏时才需要
sudo systemctl stop vibecanvas
sudo mv /var/lib/vibecanvas/data /var/lib/vibecanvas/data.broken-$(date +%Y%m%d%H%M)
sudo mkdir -p /var/lib/vibecanvas/data
sudo -u vibecanvas bash scripts/restore-data.sh /var/backups/vibecanvas/xxx.tar.gz /var/lib/vibecanvas/data
sudo systemctl start vibecanvas
```

改过 `.env.production` 也属于一次变更：把旧的那份单独存一份，回滚时一起换回来。

## 6. 数据迁移

### 6.1 换服务器 / 换数据盘

```bash
# 旧服务器
DATA_DIR=/var/lib/vibecanvas/data bash scripts/backup-data.sh /tmp
scp /tmp/vibecanvas-data-*.tar.gz new-host:~/

# 新服务器（服务未启动时）
bash scripts/restore-data.sh ~/vibecanvas-data-*.tar.gz /var/lib/vibecanvas/data
```

### 6.2 数据目录里有什么

| 路径 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `image-tasks.json` | 配图任务记录（状态、归属、额度计数） | 我的配图 / 任务历史丢失，额度计数清零 |
| `generation-assets/` | 真正生成的配图文件 | 历史配图打不开 |
| `events/events-YYYY-MM-DD.jsonl` | 产品事件 | 统计断档 |
| `feedback/feedback-YYYY-MM-DD.jsonl` | 用户反馈 | 反馈丢失 |

用户的作品本身不在服务器上：没开云同步时存在用户浏览器（IndexedDB），开了云同步时在 Supabase。

### 6.3 数据库结构变更

`supabase/migrations/` 下按序号放 SQL。升级时在 Supabase SQL Editor 里按顺序执行缺的那几个，
执行前先跑一次 `npm run backup:db`。

## 7. 备份与恢复

### 7.1 本地数据（已实际演练）

```bash
DATA_DIR=/var/lib/vibecanvas/data bash scripts/backup-data.sh /var/backups/vibecanvas
# 恢复到空目录（推荐，起服务前再把 DATA_DIR 指过去）
bash scripts/restore-data.sh /var/backups/vibecanvas/vibecanvas-data-20261030T135338Z.tar.gz /var/lib/vibecanvas/data-restored
# 直接盖回线上目录：必须先停服务，并显式加 --force
sudo systemctl stop vibecanvas
bash scripts/restore-data.sh /var/backups/vibecanvas/vibecanvas-data-20261030T135338Z.tar.gz /var/lib/vibecanvas/data --force
```

打包时服务不用停：配图任务写入是「整文件重写 + 原子替换」，最多丢正在写的那一条。

**本次已执行的验证（2026-10-30，本机）**：

1. 对 `data/` 打包，得到 18 MB、38 个条目的压缩包；
2. 解到空目录 `.tmp-test-data/restore-check`；
3. 比对：`image-tasks.json` 13 条任务、结构哈希一致；`generation-assets/` 35 个文件文件名与字节数完全一致；
4. 用 `DATA_DIR=恢复目录` 启动服务，`/api/image-tasks/<id>` 回 `completed`，
   对应图片接口回 200、1,244,361 字节。

### 7.2 云端作品库（逻辑备份，未对真实项目执行）

```bash
npm run backup:db                                   # 导出到 backups/cloud_works-<时间>.json
npm run restore:db -- <备份文件> --dry-run          # 先看会写多少行
npm run restore:db -- <备份文件> --yes              # 真正写回，按主键覆盖，可重复执行
```

写回后会按 id 抽查行数，缺行会报错并提示原样重跑。

**已执行的验证（2026-10-30，本机）**：用本地起的假 PostgREST 服务跑通
「导出 → 清空 → 恢复 → 校验」全流程（7 个用例，见 `cloud-backup.test.js`），
包括分页导出、重复执行不产生重复行、演练模式不写库、残缺行被跳过、校验能发现缺失行。

**未执行的部分**：对真实 Supabase 项目的备份与恢复。原因有两个：本机没有配置 Supabase；
往你正在使用的真实项目里写测试数据会污染线上数据。拿到项目和密钥后，
建议先在空项目上跑一遍 `--dry-run` → `--yes` 再上生产。

Storage 里的图片文件不在上面这套脚本里。需要整包备份时，用 Supabase 控制台的
Database / Storage 备份功能，或在数据库迁移前手动导出 bucket。

## 8. 本次实际做了什么、没做什么

| 项目 | 状态 |
| --- | --- |
| 生产构建（JSX 编译、Tailwind、自托管字体与第三方库）| 已执行，产物在 `public/` |
| 用生产配置 + 自签证书在本机起服务，验证 HTTPS 与安全响应头 | 已执行 |
| 静态资源白名单、`/.env` 等仓库文件不可读 | 已执行（均回 404） |
| `/healthz`、`/readyz` | 已执行 |
| 产品事件、反馈接口与文件落盘 | 已执行 |
| 本地数据备份 + 恢复 + 起服务验证 | 已执行（见 7.1）|
| 云端备份恢复 | 仅对假接口执行，未对真实 Supabase 执行 |
| 端到端验收（新用户→生成→编辑→保存→重开→导出）| 已执行，10/10 |
| 移动端、慢网络、模型失败、额度耗尽 | 已执行，7/7 |
| 登录过期 | 已用自动化测试覆盖服务端返回，未在真实 Supabase 上跑 |
| 用 Cloudflare 临时隧道临时对外，并通过隧道跑完端到端 | 已执行，见 `docs/TRIAL.md` 第 6 节 |
| 部署到真实服务器、买域名、备案、正式对外 | **未执行**，需要你先确认第 2 节的资源 |
| 真实用户试用 | **未执行** |

## 9. 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动即退出并打印「配置检查未通过」 | 缺变量或不符合生产要求 | 按提示补齐后重跑 `scripts/check-config.js` |
| 页面能开，点生成提示「请求来源无效」 | `APP_ORIGIN` 和实际访问地址不一致 | 改成浏览器地址栏里的那个地址，重启 |
| `/readyz` 返回 503 | 静态产物缺失或数据目录不可写 | 看 `checks` 里哪一项 ok=false |
| 所有请求都被当成同一个来源 | 反向代理没传 `X-Forwarded-For`，或 `TRUST_PROXY` 设错 | 按 `deploy/Caddyfile` 配置，确认只信任自己的代理 |
| 配图一直排队 | 全局并发/每分钟限制较小 | 调 `IMAGE_MAX_CONCURRENT`、`IMAGE_PER_MINUTE` |
| 重启后额度又满了 | 生成额度计数在内存里，重启清零 | 已知限制，见 `docs/TRIAL.md` |
