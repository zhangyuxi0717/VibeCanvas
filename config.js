'use strict';
const os = require('node:os');
const path = require('node:path');

/* ----------------------------------------
 * 环境配置：开发 / 测试 / 生产各读各的变量。
 *
 * 生产环境启动即校验，缺什么直接退出，不带病上线；
 * 开发环境缺变量只降级，方便本机跑。
 * ---------------------------------------- */

const PROFILES = ['development', 'test', 'production'];

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/* ----------------------------------------
 * 商品表：价格、额度数量、有效期全部写在这里，改价格只改环境变量。
 * 读不出来就报错，不能带着一份半懂不懂的商品表去收款。
 * ---------------------------------------- */
function parseProducts(raw) {
  const errors = [];
  const products = [];
  if (raw == null || String(raw).trim() === '') {
    errors.push('BILLING_ENABLED=true 时必须配置 BILLING_PRODUCTS（JSON 数组），不能使用内置默认价格');
    return { products, errors };
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    errors.push('BILLING_PRODUCTS 不是合法 JSON：' + err.message);
    return { products, errors };
  }
  if (!Array.isArray(list) || !list.length) {
    errors.push('BILLING_PRODUCTS 必须是非空数组');
    return { products, errors };
  }
  const seen = new Set();
  list.forEach((item, index) => {
    const where = `BILLING_PRODUCTS[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${where} 必须是对象`); return; }
    const id = String(item.id || '');
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) errors.push(`${where}.id 只能是小写字母、数字和短横线（2–32 位）`);
    else if (seen.has(id)) errors.push(`${where}.id 重复：${id}`);
    else seen.add(id);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title || title.length > 40) errors.push(`${where}.title 必填且不超过 40 字`);
    const priceFen = Number.isInteger(item.priceFen)
      ? item.priceFen
      : (typeof item.priceYuan === 'number' ? Math.round(item.priceYuan * 100) : NaN);
    if (!Number.isInteger(priceFen) || priceFen < 1 || priceFen > 1_000_000) errors.push(`${where}.priceFen 必须是 1–1000000 的整数（单位：分）`);
    if (!Number.isInteger(item.credits) || item.credits < 1 || item.credits > 100_000) errors.push(`${where}.credits 必须是 1–100000 的整数`);
    const days = item.creditValidDays === undefined ? 0 : item.creditValidDays;
    if (!Number.isInteger(days) || days < 0 || days > 3650) errors.push(`${where}.creditValidDays 必须是 0–3650 的整数（0 表示长期有效）`);
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    if (description.length > 120) errors.push(`${where}.description 不超过 120 字`);
    products.push({ id, title, priceFen, credits: item.credits, creditValidDays: days, description });
  });
  return { products, errors };
}

function loadConfig(env = process.env) {
  const profile = PROFILES.includes(env.NODE_ENV) ? env.NODE_ENV : 'development';
  const production = profile === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data'));
  const staticRoot = path.resolve(env.STATIC_ROOT || path.join(process.cwd(), 'public'));
  const { products, errors: productErrors } = parseProducts(env.BILLING_PRODUCTS);

  const config = {
    profile,
    production,
    port: int(env.PORT, production ? 8080 : 3000),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    dataDir,
    staticRoot,
    // 生产必须明确写出对外地址，用于同源校验和回跳；开发默认 http://127.0.0.1:端口
    appOrigin: (env.APP_ORIGIN || (production ? '' : `http://127.0.0.1:${int(env.PORT, 3000)}`)).replace(/\/$/, ''),
    trustProxy: bool(env.TRUST_PROXY, production),
    tls: {
      certPath: env.TLS_CERT_PATH || '',
      keyPath: env.TLS_KEY_PATH || '',
      enabled: Boolean(env.TLS_CERT_PATH && env.TLS_KEY_PATH),
    },
    security: {
      hsts: bool(env.ENABLE_HSTS, production),
      cspReportOnly: bool(env.CSP_REPORT_ONLY, false),
      maxHeaderBytes: int(env.MAX_HEADER_BYTES, 16 * 1024),
      requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 130000),
      headersTimeoutMs: int(env.HEADERS_TIMEOUT_MS, 20000),
    },
    trial: {
      // 小范围试用：只允许名单内的邮箱登录并生图；留空表示不限制（仅开发用）
      allowedEmails: uniqueEmails(env.TRIAL_ALLOWED_EMAILS),
      // 名单长度就是试用人数上限；名单超了直接拒绝启动，避免以为限制了其实没限制
      maxUsers: int(env.TRIAL_MAX_USERS, 10),
      generatePerUserDailyLimit: int(env.GENERATE_PER_USER_DAILY_LIMIT, 50),
      imagePerUserDailyLimit: int(env.IMAGE_PER_USER_DAILY_LIMIT, 15),
      generateDailyLimit: int(env.GENERATE_DAILY_LIMIT, 1000),
      imageDailyLimit: int(env.IMAGE_DAILY_LIMIT, 20),
      imagePerMinute: int(env.IMAGE_PER_MINUTE, 5),
      imageQueueLimit: int(env.IMAGE_QUEUE_LIMIT, 20),
      imageMaxConcurrent: int(env.IMAGE_MAX_CONCURRENT, 2),
    },
    cloud: {
      // 不填 Supabase 也能试用：作品只存在浏览器本地，登录和云同步不可用。
      // CLOUD_REQUIRED=true 时缺配置会直接拒绝启动，适合「必须有账号体系」的部署。
      required: bool(env.CLOUD_REQUIRED, false),
      configured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY),
    },
    billing: {
      // 默认关闭：没有配置商品、密钥和渠道之前，不对外收钱。
      enabled: bool(env.BILLING_ENABLED, false),
      provider: String(env.BILLING_PROVIDER || 'mock').toLowerCase(),
      currency: 'CNY',
      products,
      productErrors,
      creditsPerTask: Math.min(int(env.BILLING_CREDITS_PER_TASK, 1), 100),
      signupGrantCredits: Math.min(nonNegInt(env.BILLING_SIGNUP_GRANT_CREDITS, 0), 10_000),
      signupGrantValidDays: Math.min(nonNegInt(env.BILLING_SIGNUP_GRANT_VALID_DAYS, 30), 3650),
      orderTtlMinutes: Math.min(int(env.BILLING_ORDER_TTL_MINUTES, 30), 1440),
      uncertainHoldMinutes: Math.min(int(env.BILLING_UNCERTAIN_HOLD_MINUTES, 30), 1440),
      accountSecret: env.BILLING_ACCOUNT_SECRET || '',
      adminToken: env.ADMIN_TOKEN || '',
      dir: path.join(dataDir, 'billing'),
      returnUrl: env.BILLING_RETURN_URL || '',
      alipay: {
        appId: env.ALIPAY_APP_ID || '',
        privateKey: env.ALIPAY_PRIVATE_KEY || '',
        privateKeyPath: env.ALIPAY_PRIVATE_KEY_PATH || '',
        publicKey: env.ALIPAY_PUBLIC_KEY || '',
        publicKeyPath: env.ALIPAY_PUBLIC_KEY_PATH || '',
        gateway: env.ALIPAY_GATEWAY || 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        notifyUrl: env.ALIPAY_NOTIFY_URL || '',
        returnUrl: env.ALIPAY_RETURN_URL || '',
        sellerId: env.ALIPAY_SELLER_ID || '',
      },
    },
    telemetry: {
      enabled: bool(env.TELEMETRY_ENABLED, true),
      file: path.join(dataDir, 'events'),
      feedbackFile: path.join(dataDir, 'feedback'),
    },
  };

  const errors = [];
  const warnings = [];
  if (production) {
    if (!config.appOrigin) errors.push('APP_ORIGIN 未设置，生产环境必须写明对外地址，例如 https://canvas.example.cn');
    else if (!config.appOrigin.startsWith('https://')) errors.push('APP_ORIGIN 必须是 https:// 地址');
    if (!fsExists(path.join(config.staticRoot, 'index.html'))) errors.push(`静态构建产物缺失：${config.staticRoot}/index.html，请先运行 npm run build`);
    if (insideTempDir(config.dataDir)) errors.push(`DATA_DIR 位于临时目录（${os.tmpdir()}）中，重启会丢数据；请挂载持久磁盘`);
    if (config.tls.enabled && !(fsExists(config.tls.certPath) && fsExists(config.tls.keyPath))) errors.push('TLS_CERT_PATH / TLS_KEY_PATH 指向的文件不存在');
    if (!config.tls.enabled && !bool(env.BEHIND_TLS_PROXY, false)) errors.push('未配置 TLS 证书，也未声明 BEHIND_TLS_PROXY=true（由反向代理终止 TLS）');
    if (!config.trial.allowedEmails.length && !bool(env.TRIAL_OPEN, false)) errors.push('TRIAL_ALLOWED_EMAILS 为空：小范围试用必须写明受邀邮箱；确实要公开访问请显式设置 TRIAL_OPEN=true');
    if (config.trial.allowedEmails.length > config.trial.maxUsers) errors.push(`试用名单有 ${config.trial.allowedEmails.length} 个邮箱，超过 TRIAL_MAX_USERS=${config.trial.maxUsers}；请删减名单或调高上限`);
    if (!config.trial.allowedEmails.length) warnings.push('未限制试用名单（TRIAL_OPEN=true），任何人都能用完生成额度');
  }
  if (config.billing.enabled) {
    const b = config.billing;
    errors.push(...b.productErrors);
    if (!['mock', 'alipay'].includes(b.provider)) errors.push(`BILLING_PROVIDER=${b.provider} 不支持，只能是 mock 或 alipay`);
    if (production && b.provider === 'mock') errors.push('生产环境不能使用模拟支付渠道（BILLING_PROVIDER=mock）；请改用 alipay 并完成沙箱验证');
    if (!b.accountSecret) {
      if (production) errors.push('BILLING_ACCOUNT_SECRET 未设置：生产环境必须提供至少 32 个字符的密钥，用于签发额度账户凭证');
    } else if (b.accountSecret.length < 32) {
      errors.push('BILLING_ACCOUNT_SECRET 至少需要 32 个字符');
    }
    if (b.provider === 'alipay') {
      const a = b.alipay;
      if (!a.appId) errors.push('BILLING_PROVIDER=alipay 时必须配置 ALIPAY_APP_ID');
      if (!a.privateKey && !a.privateKeyPath) errors.push('BILLING_PROVIDER=alipay 时必须配置应用私钥（ALIPAY_PRIVATE_KEY_PATH 或 ALIPAY_PRIVATE_KEY）');
      else if (a.privateKeyPath && !fsExists(a.privateKeyPath)) errors.push(`ALIPAY_PRIVATE_KEY_PATH 指向的文件不存在：${a.privateKeyPath}`);
      if (!a.publicKey && !a.publicKeyPath) errors.push('BILLING_PROVIDER=alipay 时必须配置支付宝公钥（ALIPAY_PUBLIC_KEY_PATH 或 ALIPAY_PUBLIC_KEY）');
      else if (a.publicKeyPath && !fsExists(a.publicKeyPath)) errors.push(`ALIPAY_PUBLIC_KEY_PATH 指向的文件不存在：${a.publicKeyPath}`);
      if (!a.gateway.startsWith('https://')) errors.push('ALIPAY_GATEWAY 必须是 https 地址');
      const notify = a.notifyUrl || (config.appOrigin ? `${config.appOrigin}/api/billing/notify/alipay` : '');
      if (!notify) errors.push('无法确定支付宝异步通知地址：请配置 ALIPAY_NOTIFY_URL 或 APP_ORIGIN');
      else if (!notify.startsWith('https://')) errors.push('支付宝异步通知地址必须是公网 https 地址');
    }
    if (!b.adminToken) warnings.push('未设置 ADMIN_TOKEN：运营接口（查单、暂停生成、调整额度）不可用');
    else if (b.adminToken.length < 16) warnings.push('ADMIN_TOKEN 少于 16 个字符，建议换成长随机串');
    if (b.signupGrantCredits > 0) warnings.push(`新账户会赠送 ${b.signupGrantCredits} 额度：当前没有登录体系，重复创建账户可以重复领取，请谨慎开启`);
    if (!production) warnings.push(`付费功能已开启，支付渠道为 ${b.provider}；未配置真实密钥时只在沙箱/本地可用`);
  }
  if (!config.cloud.configured) {
    const line = 'Supabase 未配置：登录、云同步、云端备份不可用；作品只保存在用户浏览器本地。';
    if (config.cloud.required) errors.push(line.replace('不可用；', '不可用，而 CLOUD_REQUIRED=true 要求必须可用。'));
    else warnings.push(line);
  }
  if (!config.telemetry.enabled) warnings.push('TELEMETRY_ENABLED=false：不记录产品事件和反馈。');

  return { ...config, errors, warnings, ok: errors.length === 0 };
}

function uniqueEmails(raw) {
  const list = String(raw || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return [...new Set(list)];
}

function insideTempDir(target) {
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  return path.resolve(target).toLowerCase().startsWith(tmp);
}

function fsExists(file) {
  try { return require('node:fs').statSync(file).isFile(); } catch { return false; }
}

module.exports = { loadConfig, insideTempDir, uniqueEmails };
