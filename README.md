# VibeCanvas

需要 Node.js 20 或更新版本。所有模型请求由服务端发送，密钥不下发到浏览器。

页面本身不再依赖 CDN：`npm run build` 会把 `VibeCanvas.html` 里的 JSX 编译成普通 JS，
并把 Tailwind 样式、字体和 React / Lucide / html2canvas 打包进 `public/`，由服务进程一起托管。
构建产物的文件名带内容哈希，改完代码重新构建即可，用户不用清缓存。

## 本地启动

1. 选一个示例文件复制成不带 `.example` 的那份，仓库里只有示例、没有真实密钥：

   | 用途 | 复制的源 | 复制成 | 启动命令 |
   | --- | --- | --- | --- |
   | 本机开发 | `.env.development.example` | `.env.development` | `npm run dev` |
   | 本机直接跑 | `.env.example` | `.env` | `npm start` |
   | 自动化测试 | `.env.test.example` | `.env.test` | `npm run test:env` |
   | 服务器上线 | `.env.production.example` | `.env.production` | `npm run start:prod` |

   至少填写 `MODEL_API_URL`（OpenAI 兼容 Chat Completions 完整地址）、`MODEL_NAME` 和 `MODEL_API_KEY`。
   请使用支持 `response_format: {type: "json_object"}` 的模型服务。
2. 安装依赖并构建：

```powershell
npm install
npm run build
```

3. 启动：

```powershell
npm run dev      # 读 .env.development
npm start        # 读 .env
```

4. 在浏览器打开 http://127.0.0.1:3000/ ，不要直接双击 HTML 文件。停止服务可按 Ctrl+C。
   如果 3000 端口已被占用，可先执行 `$env:PORT='3004'`（这是 Windows PowerShell 的写法；bash 里是 `PORT=3004`），
   再启动并打开 http://127.0.0.1:3004/。
5. 运行本地检查：`npm test`（82 个用例）；`npm run check:config` 自检配置；`npm run e2e` 跑端到端验收
   （需要先构建并起服务，详见 `docs/DEPLOY.md`）。

输入上限 500 字；标题 18 字、副标题 30 字、正文 80 字、标签 1–4 个（每个最多 10 字）。模型超时为 45 秒；本地按 IP 限制每分钟 10 次。限制在内存中，重启服务会重置，仅适用于本地 MVP。

时间、地点和主办方字段仅保留用户输入中原样出现的内容。文案由模型生成，请发布前自行核对；字段检查不能保证模型自由文本绝对没有事实性错误。

## 照片海报

首次启动前执行 `npm install` 安装图片解码依赖。纯文字仍使用 `MODEL_API_*` 和 `MODEL_NAME`。照片生成需在 `.env` 中另行填写 `VISION_API_URL`、`VISION_MODEL_NAME` 和 `VISION_API_KEY`。当前图片请求遵循 DeepSeek 官方 Chat Completions 图像输入格式，示例地址为 `https://api.deepseek.com/chat/completions`，示例模型为 `deepseek-flash`；请使用支持图像输入的服务和该服务自己的有效密钥，不要假定任意兼容接口支持视觉。

JPEG、PNG、WebP 单张最多 8MB、4000 万像素；服务器校验并将图片缩小到最长边 1600 像素后发送模型。浏览器中的原图用于预览和导出，不持久化在服务端。照片会发送至配置的视觉模型服务，提交即表示你同意处理。人物身份、学校、日期、地点、主办方不应从照片推断；生成内容仍需人工检查。主题与照片不一致的检测依赖模型判断，可能有误判或漏判。

若使用本机代理，可在 PowerShell 设置 `HTTPS_PROXY` 后运行 `node --use-env-proxy --env-file=.env server.js`。Node.js 需支持该选项（例如 Node 24）。修改环境配置或源代码后需重启服务。

## AI 配图

选择「AI 配图」才会向图片服务发送付费请求；先生成文案和一段可编辑的配图描述，再由 `image-prompts.js` 按三套模板各自的构图要求派生三段提示词，创建三个图片任务：极简卡片、大图排版、杂志拼接各得一张互不相同的图。因此一次生成按三张计费、扣三次单用户额度（默认每日 15）。失败或超时不会自动重试；某一张失败不会影响已经成功的另外两张，可单独点击重生成。新图完成前保留旧图，文字始终独立排版。生成图可能仍含有文字或标记，需人工检查。

界面上编辑的中文配图描述不会直接送去画图。本地 SDXL 一类模型的文本编码器读不懂中文，中文提示词只会得到一张与内容无关的图。因此文案接口同时返回 `imagePromptEn`（与中文含义一致的英文），`image-prompts.js` 用英文派生三段提示词；用户在文本框里改过中文后，重新生成配图前会先调用 `POST /api/image-prompt` 把新的中文翻成英文（只走文字模型，不消耗图片额度）。英文不可用时退回中文并在界面上提示结果可能不符。实际送去生成的英文提示词可在配图描述下方展开查看。

上传照片模式不同：你只提供一张照片，三套模板各自裁剪这一张，不会调用图片服务。

在 `.env` 中独立设置 `IMAGE_API_URL`、`IMAGE_MODEL_NAME`、`IMAGE_API_KEY`、`IMAGE_SIZE` 和 `IMAGE_TIMEOUT_MS`，参考 `.env.example`。当前适配 OpenAI Images API 的生成格式（不是 Chat Completions），需要图片服务自己的密钥；不读取或复用文字密钥。对于 URL 返回值，仅允许预设 OpenAI 图片主机，禁止重定向，并限制下载大小和时间。其他服务需单独实现适配器。

如果使用本机 ComfyUI 或其他本地图片模型已经导出 PNG/JPEG/WebP，可设置 `LOCAL_IMAGE_PATH` 指向服务端可读取的输出文件，例如：`E:\\imagesLLM\\ComfyUI-portable\\ComfyUI_windows_portable\\ComfyUI\\output\\muse_lab_test_00001_.png`。设置后图片任务会读取该本地文件并通过同一套任务队列、幂等、额度、持久化和权限接口返回，不调用远程图片服务；当前版本会复用这个文件，主题提示词不会重新驱动 ComfyUI 生成。文件路径只保存在服务端环境变量中，不会返回给浏览器。

可配置 `IMAGE_MAX_CONCURRENT`、`IMAGE_DAILY_LIMIT` 和 `IMAGE_PER_MINUTE`；默认分别为 2、20 和 5。每天计数按 UTC 日期重置。任务和结果现在按 `IMAGE_TASK_STORE_PATH` / `IMAGE_TASK_ASSET_DIR` 持久化，已完成、失败和不确定任务默认保留 30 分钟，仍不适合多进程部署或正式计费。服务日志仅包含请求次数、耗时、结果、提供商请求 ID 和可用的用量数值，不记录图片、提示词或密钥。日志里的请求次数不是费用。

小范围试用可启用持久化任务执行器：`IMAGE_SERVICE_ENABLED` 控制总开关，`IMAGE_PER_USER_DAILY_LIMIT` 控制单用户每日额度，`IMAGE_QUEUE_LIMIT` 控制等待队列，`IMAGE_TASK_STORE_PATH` 保存任务元数据，`IMAGE_TASK_ASSET_DIR` 保存完成图片。额度在任务入队前预占；成功、普通失败和供应商不确定状态都会消耗用户额度，取消的排队任务也保留额度记录，不把用户额度退回解释成供应商没有收费。供应商超时会进入 `uncertain`，服务重启时运行中任务也会恢复为 `uncertain`，不会自动重试付费请求。只能由同一用户使用幂等键查询、取消和读取结果。

浏览器刷新不会恢复轮询，也不会自动重新发起生图；需要用户明确操作重试。生成图被读取到当前页面的临时内存中，关闭页面后不保留。视觉与图片模型均需各自配置并按各自供应商的规则计费。

图片任务现在由本地有界执行器处理：任务元数据写入 `IMAGE_TASK_STORE_PATH`，结果图片写入 `IMAGE_TASK_ASSET_DIR/generation-assets`。幂等键按用户隔离；重复提交返回同一任务。全局并发、等待队列、全局每日额度、单用户每日额度和每分钟请求数都会在供应商调用前检查并预占。达到预算或发现异常时将 `IMAGE_SERVICE_ENABLED=false`，服务会停止新增付费请求，已有任务继续查询。

任务状态包括 `queued`、`running`、`completed`、`failed`、`cancelled` 和 `uncertain`。供应商超时、服务重启或结果不明确时使用 `uncertain`，不会自动重试；用户必须确认供应商侧状态后再用新的幂等键手动发起。成功、普通失败、不确定和排队取消都会保留额度消耗记录，用户额度与供应商实际费用分开记录。过期任务和结果文件按 TTL 清理。文本和视觉生成也有 `GENERATE_SERVICE_ENABLED`、`GENERATE_DAILY_LIMIT` 和 `GENERATE_PER_USER_DAILY_LIMIT` 保护，但它们是同步请求，不会在服务端伪造后台任务状态。

## 本地作品库与自动保存

作品与图片 Blob 保存在当前浏览器、当前网站地址对应的 IndexedDB 数据库 `vibecanvas-works` 中。应用仅使用 localStorage 保存最近打开的作品 ID，不存放图片或密钥。不同端口属于不同站点来源，作品库不会在端口之间自动共享；请固定使用同一地址和端口。清除浏览器数据、使用无痕模式或更换浏览器/设备可能丢失或无法看到作品，暂无跨设备同步。

修改后约 700 毫秒触发保存，缩略图在停止修改约 2.2 秒后更新；状态显示真实写入结果。保存未完成时关闭页面可能丢失最新修改。保存失败可以继续编辑和尝试导出，并点击「重试保存」；切换作品时若写入失败，需要明确选择是否放弃。作品数据和图片在一个 IndexedDB 事务中保存；重复作品保存自己的 Blob 副本。多标签通过版本校验及通知检测冲突，需从作品库重新打开最新版本才能继续保存，未保存修改不会被自动覆盖。

当前版本无法打开或覆盖未知版本的作品。数据库、浏览器配额和损坏的图片可能导致保存或恢复失败；应用会提示而不会清空当前编辑内容。生成任务仍是临时任务，刷新不会恢复正在运行的模型任务。

自动检查运行 `npm test`。浏览器 IndexedDB 事务测试页为 `work-library-browser-test.html`，需要通过本地测试服务器访问并同时提供 `work-library.js`。

## 多页小红书图文

在左侧“内容形式”选择“连续多页图文”，输入主题后生成 3–6 页连续内容。第一张是封面，最后一张是结尾页，中间页面用于推进信息。页面可以新增、复制、删除和调整顺序并逐页编辑；整组默认共享当前模板、配色和已有图片，不会为每一页自动调用图片服务。

导出支持当前页 PNG 和整组 ZIP，预设为 1080×1440（3:4），文件按页码命名。导出会等待字体和图片加载，并显示当前页进度；失败时保留编辑内容，修复后可再次导出。旧版单页作品打开时会转换为封面、内容、结尾三页，转换结果会进入自动保存。

## 生成质量与排版检查

生成过程显示解析输入、调用模型、校验并排版三个真实阶段，不再显示固定百分比。编辑区提供“重新生成文案”和多页作品的“重新生成当前页”：前者覆盖当前作品文字，后者只覆盖当前页文字，二者都会再次调用文本模型；AI 配图仍由单独按钮触发，并明确提示会再次调用图片服务。

编辑时会对标题、副标题、正文长度、换行和缺失图片给出启发式提示。提示用于人工复核，不宣称能够自动判断全部视觉质量。固定评估样例见 `docs/evaluation-samples.md`，覆盖纯文字、照片、多页、信息缺失、长文本、失败重试、批量导出和移动端键盘操作。

## 账号与云端作品

云端版本使用 Supabase Magic Link 登录、Postgres 保存作品 JSON、私有 Storage 保存图片。服务端只接受 `Authorization: Bearer` 会话令牌，并在每次读取、修改、删除和图片签名请求中检查当前用户归属。浏览器只接收公开 anon key；`SUPABASE_SERVICE_ROLE_KEY` 只放在服务端 `.env`。

配置 `.env`：

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-public-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
SUPABASE_STORAGE_BUCKET=vibecanvas-private
```

在 Supabase Dashboard 启用 Magic Link，创建私有 bucket `vibecanvas-private`，并执行 `supabase/migrations/001_cloud_works.sql`。本地启动后点击“登录并同步”，登录成功后可查看云端作品并把本地作品迁移到云端。迁移使用本地作品 ID 幂等，成功前不会删除 IndexedDB 原件。

云端更新使用 `revision` 做乐观并发控制。版本不一致时返回冲突，页面保留本地编辑，不静默覆盖其他设备。离线或云端失败时，本地自动保存和图片下载继续可用，恢复网络后可点击“同步到云端”重试。真实 Supabase 登录、数据库和私有图片访问需要完成上述配置后再验证。
### ComfyUI 实时生图

要让每个主题真正驱动本地模型，在 ComfyUI 中打开可用的文生图工作流，点击菜单里的 `Save (API Format)`，将导出的 JSON 保存到服务端可访问的位置。配置：

```env
COMFYUI_API_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_PATH=E:\imagesLLM\ComfyUI-portable\ComfyUI_windows_portable\ComfyUI\user\default\workflows\vibecanvas-api.json
COMFYUI_PROMPT_NODE_ID=6
COMFYUI_POLL_INTERVAL_MS=1500
COMFYUI_TIMEOUT_MS=300000
```

服务端会向 ComfyUI 的 `/prompt` 提交 API workflow，向指定文本节点注入用户的 `imagePrompt`，轮询 `/history/{prompt_id}`，再通过 `/view` 读取生成图片。配置了 `COMFYUI_WORKFLOW_PATH` 后优先使用 ComfyUI，未配置时才使用本地固定 PNG 或远程图片服务。界面蓝图 JSON 不能直接提交到 `/prompt`；必须使用 `Save (API Format)` 导出的节点映射。不同模型的提示词节点 ID、输出节点和自定义节点可能不同，需按实际 workflow 设置 `COMFYUI_PROMPT_NODE_ID`。当前已实现标准 ComfyUI API 流程，但尚未用你的具体 workflow 和模型完成真实生图验证。
本项目已根据当前 ComfyUI 最近一次成功记录生成 `comfyui-workflow.json`，默认提示词节点为 `4`，使用 `sd_xl_base_1.0.safetensors` 和 `SaveImage` 节点。若你在 ComfyUI 中更换模型或工作流，请重新导出 API JSON 并更新 `COMFYUI_WORKFLOW_PATH` / `COMFYUI_PROMPT_NODE_ID`。

## 构建、部署与试用

| 想做的事 | 看哪里 |
| --- | --- |
| 生产构建原理（`public/` 里有什么、缓存怎么失效） | `scripts/build.mjs` |
| 首次部署、HTTPS 两种方式、升级、回滚、数据迁移、备份恢复 | `docs/DEPLOY.md` |
| 哪些数据发给哪个模型服务、作品存在哪、怎么删 | `docs/DATA-FLOW.md` |
| 试用人数与额度、验收记录、已知限制 | `docs/TRIAL.md` |
| 购买额度、支付渠道、退款规则、开启收款前的确认事项 | `docs/BILLING.md` |
| 服务器上的服务与反向代理配置 | `deploy/vibecanvas.service`、`deploy/Caddyfile` |

常用命令：

```bash
npm run build           # 生成 public/，改前端后必须重新执行
npm test                # 108 个接口与单元测试
npm run check:config    # 自检当前配置，不启动服务、不打印密钥
npm run backup:data     # 打包 DATA_DIR
npm run backup:db       # 导出云端作品表（需要 Supabase 配置）
npm run e2e             # 端到端验收（需要先起服务）
npm run check:ui        # 移动端 / 慢网络 / 模型失败 / 额度耗尽
npm run trial           # 临时给别人看：Cloudflare 隧道 + 生产配置启动
```

健康检查：`/healthz` 只表示进程活着；`/readyz` 会检查静态产物、数据目录和数据库，返回 503 时不要接流量。
