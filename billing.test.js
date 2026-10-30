'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLedger } = require('./billing/ledger');
const { createOrders } = require('./billing/orders');
const { createAccounts } = require('./billing/accounts');
const { createBilling } = require('./billing/service');
const { createAlipayProvider, signContent, signRSA2 } = require('./billing/providers/alipay');
const { createApp, loadConfig } = require('./server');
const { createTelemetry } = require('./telemetry');

const SECRET = 's'.repeat(40);

function tempDir(prefix = 'vc-billing-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function billingConfig(dir, overrides = {}) {
  return {
    production: false,
    appOrigin: 'http://127.0.0.1:3000',
    billing: {
      enabled: true,
      provider: 'mock',
      currency: 'CNY',
      products: [{ id: 'starter', title: '体验包', priceFen: 990, credits: 3, creditValidDays: 90, description: '3 张 AI 配图' }],
      creditsPerTask: 1,
      signupGrantCredits: 0,
      signupGrantValidDays: 30,
      orderTtlMinutes: 30,
      uncertainHoldMinutes: 30,
      accountSecret: SECRET,
      adminToken: 'admin-token-1234567890',
      dir,
      returnUrl: '',
      alipay: { appId: '', privateKey: '', privateKeyPath: '', publicKey: '', publicKeyPath: '', gateway: '', notifyUrl: '', returnUrl: '', sellerId: '' },
      ...overrides,
    },
  };
}

function newBilling(overrides = {}, options = {}) {
  const dir = tempDir();
  return { dir, billing: createBilling({ config: billingConfig(dir, overrides), now: options.now, imageTasks: options.imageTasks }) };
}

/**
 * 按模拟渠道的规则签一条「支付通知」。
 * 这样测试可以构造出「签名是真的、金额是错的」这种真实事故，
 * 而不用去改渠道内部状态。
 */
function mockNotify(outTradeNo, amountFen, { accountSecret = SECRET, appId = 'mock-app-001', tradeStatus = 'TRADE_SUCCESS', tradeNo = 'MOCKTEST001' } = {}) {
  const key = crypto.createHmac('sha256', accountSecret).update('vibecanvas-mock-provider').digest('hex');
  const params = {
    app_id: appId,
    out_trade_no: outTradeNo,
    total_amount: (amountFen / 100).toFixed(2),
    trade_status: tradeStatus,
    trade_no: tradeNo,
    sign_type: 'MOCK_HMAC',
  };
  const content = Object.keys(params)
    .filter((name) => name !== 'sign' && name !== 'sign_type')
    .filter((name) => params[name] !== '')
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&');
  params.sign = crypto.createHmac('sha256', key).update(content).digest('base64url');
  return params;
}

/* ----------------------------------------
 * 额度流水
 * ---------------------------------------- */

test('额度流水：购买、预占、消耗、释放、调整都能算出同一份余额', () => {
  const dir = tempDir();
  const ledger = createLedger({ dir });
  ledger.grant({ accountId: 'a1', credits: 5, reason: '测试发放' });
  assert.equal(ledger.balance('a1').available, 5);

  ledger.reserve({ accountId: 'a1', taskId: 't1', credits: 2 });
  assert.equal(ledger.balance('a1').available, 3);
  assert.equal(ledger.balance('a1').reserved, 2);

  ledger.consume({ taskId: 't1' });
  assert.equal(ledger.balance('a1').available, 3);
  assert.equal(ledger.balance('a1').reserved, 0);

  ledger.reserve({ accountId: 'a1', taskId: 't2', credits: 1 });
  ledger.release({ taskId: 't2', reason: '失败了' });
  assert.equal(ledger.balance('a1').available, 3);

  ledger.adjust({ accountId: 'a1', credits: 2, reason: '补偿' });
  assert.equal(ledger.balance('a1').available, 5);
  const negative = ledger.adjust({ accountId: 'a1', credits: -8, reason: '追回' });
  assert.equal(negative.shortfall, 3);
  assert.equal(ledger.balance('a1').available, 0);
  assert.equal(fs.readFileSync(ledger.file, 'utf8').trim().split('\n').length, ledger._all().length);
});

test('并发扣减：5 个额度、20 个请求，只有 5 个能预占成功', () => {
  const dir = tempDir();
  const ledger = createLedger({ dir });
  ledger.grant({ accountId: 'race', credits: 5, reason: '起始额度' });
  let ok = 0;
  let rejected = 0;
  for (let i = 0; i < 20; i++) {
    try { ledger.reserve({ accountId: 'race', taskId: `task-${i}`, credits: 1 }); ok++; }
    catch (err) { rejected++; assert.equal(err.code, 'INSUFFICIENT_CREDITS'); }
  }
  assert.equal(ok, 5);
  assert.equal(rejected, 15);
  assert.equal(ledger.balance('race').available, 0);
  assert.equal(ledger.balance('race').reserved, 5);
  assert.equal(ledger.openReservations().length, 5);
});

test('流水只追加：重启后按文件重放，余额和预占都不变', () => {
  const dir = tempDir();
  const first = createLedger({ dir });
  first.grant({ accountId: 'r', credits: 4, reason: '发放' });
  first.reserve({ accountId: 'r', taskId: 'k1', credits: 2 });
  first.consume({ taskId: 'k1' });
  const before = first.balance('r');
  const lines = fs.readFileSync(first.file, 'utf8').trim().split('\n').length;

  const second = createLedger({ dir });
  const after = second.balance('r');
  assert.equal(after.available, before.available);
  assert.equal(after.reserved, before.reserved);
  assert.equal(fs.readFileSync(second.file, 'utf8').trim().split('\n').length, lines);
});

test('过期批次自动归零，并留下 expire 流水', () => {
  const dir = tempDir();
  let clock = 1_000_000;
  const ledger = createLedger({ dir, now: () => clock });
  ledger.grant({ accountId: 'e', credits: 2, expiresAt: clock + 1000, reason: '短效额度' });
  assert.equal(ledger.balance('e').available, 2);
  clock += 5000;
  assert.equal(ledger.balance('e').available, 0);
  assert.ok(ledger.usage('e').some((entry) => entry.type === 'expire'));
});

test('账户凭证被篡改或换密钥后不可用', () => {
  const dir = tempDir();
  const accounts = createAccounts({ dir, secret: SECRET });
  const { account, token } = accounts.create();
  assert.equal(accounts.verify(token), account.id);
  assert.equal(accounts.verify(token.slice(0, -2) + 'xx'), null);
  const payload = Buffer.from(JSON.stringify({ v: 1, id: account.id, iat: Date.now() })).toString('base64url');
  assert.equal(accounts.verify(payload + '.' + 'a'.repeat(43)), null);
  const other = createAccounts({ dir, secret: 't'.repeat(40) });
  assert.equal(other.verify(token), null);
});

/* ----------------------------------------
 * 订单、通知、退款
 * ---------------------------------------- */

test('订单金额只来自服务端商品表，重复通知只发一次额度', () => {
  const { billing } = newBilling();
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  const { order, payUrl } = billing.createOrder(accountId, 'starter');
  assert.equal(order.amountFen, 990);
  assert.equal(order.credits, 3);
  assert.match(payUrl, /^\/api\/billing\/mock\/pay\?/);

  const params = billing.provider.buildNotify(order.outTradeNo);
  const first = billing.handleNotify('mock', params);
  assert.equal(first.ok, true);
  assert.equal(first.already, false);
  assert.equal(billing.wallet(accountId).available, 3);

  const second = billing.handleNotify('mock', params);
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  assert.equal(billing.wallet(accountId).available, 3);
  assert.equal(billing.ledger.entriesForOrder(order.outTradeNo).filter((entry) => entry.type === 'purchase').length, 1);
});

test('通知被篡改金额时验签失败，不发放额度', () => {
  const { billing } = newBilling();
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  const { order } = billing.createOrder(accountId, 'starter');
  const params = billing.provider.buildNotify(order.outTradeNo);
  params.total_amount = '0.01';
  const result = billing.handleNotify('mock', params);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SIGNATURE_INVALID');
  assert.equal(billing.wallet(accountId).available, 0);
});

test('签名有效但金额与订单不符时拒绝发货', () => {
  const { billing } = newBilling();
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  const { order } = billing.createOrder(accountId, 'starter');
  // 模拟渠道把 9.90 元收成了 0.01 元：签名是真的，金额对不上。
  const params = mockNotify(order.outTradeNo, 1);
  const result = billing.handleNotify('mock', params);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AMOUNT_MISMATCH');
  assert.equal(billing.wallet(accountId).available, 0);
  assert.equal(billing.adminOrder(order.outTradeNo).status, 'pending');
});

test('未知订单、错误 app_id 的通知都被拒绝', () => {
  const { billing } = newBilling();
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  const { order } = billing.createOrder(accountId, 'starter');
  const unknown = { ...billing.provider.buildNotify(order.outTradeNo), out_trade_no: 'VC00000000000000DEADBEEF' };
  assert.equal(billing.handleNotify('mock', unknown).ok, false);
  const wrongApp = billing.provider.buildNotify(order.outTradeNo);
  wrongApp.app_id = 'someone-else';
  assert.equal(billing.handleNotify('mock', wrongApp).ok, false);
  assert.equal(billing.wallet(accountId).available, 0);
});

test('订单超时关闭；迟到的真实支付通知仍然发放额度', () => {
  let clock = Date.now();
  const dir = tempDir();
  const billing = createBilling({ config: billingConfig(dir, { orderTtlMinutes: 1 }), now: () => clock });
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  const { order } = billing.createOrder(accountId, 'starter');
  clock += 2 * 60_000;
  const listed = billing.listOrders(accountId);
  assert.equal(listed[0].status, 'closed');
  const result = billing.handleNotify('mock', billing.provider.buildNotify(order.outTradeNo));
  assert.equal(result.ok, true);
  assert.equal(billing.wallet(accountId).available, 3);
  assert.equal(billing.adminOrder(order.outTradeNo).status, 'paid');
});

test('退款只收回订单里没用掉的额度，已消耗部分记为缺口', () => {
  const { billing } = newBilling();
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  const { order } = billing.createOrder(accountId, 'starter');
  billing.handleNotify('mock', billing.provider.buildNotify(order.outTradeNo));
  billing.reserveForTask(accountId, 'task-r1');
  billing.settle('task-r1', 'completed');
  assert.equal(billing.wallet(accountId).available, 2);

  const refunded = billing.refundOrder({ outTradeNo: order.outTradeNo, reason: '用户申请退款', actor: 'admin:test' });
  assert.equal(refunded.refund.removed, 2);
  assert.equal(refunded.refund.shortfall, 1);
  assert.equal(billing.wallet(accountId).available, 0);

  const again = billing.refundOrder({ outTradeNo: order.outTradeNo, reason: '重复点击', actor: 'admin:test' });
  assert.equal(again.already, true);
  assert.equal(billing.wallet(accountId).available, 0);
});

/* ----------------------------------------
 * 生成失败、状态不确定、重启对账
 * ---------------------------------------- */

test('生成成功记消耗，失败和取消退回额度', () => {
  const { billing } = newBilling();
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  billing.ledger.grant({ accountId, credits: 3, reason: '测试' });

  billing.reserveForTask(accountId, 'done');
  billing.settle('done', 'completed');
  assert.equal(billing.wallet(accountId).available, 2);

  billing.reserveForTask(accountId, 'failed');
  billing.settle('failed', 'failed');
  assert.equal(billing.wallet(accountId).available, 2);

  billing.reserveForTask(accountId, 'cancel');
  billing.settle('cancel', 'cancelled');
  assert.equal(billing.wallet(accountId).available, 2);
  assert.equal(billing.wallet(accountId).reserved, 0);
});

test('重启对账：任务已完成补记消耗，任务丢失退回额度', () => {
  const dir = tempDir();
  const first = createBilling({ config: billingConfig(dir), imageTasks: { peek: () => null, list: () => [] } });
  const { token } = first.createAccount({});
  const accountId = first.accountFromToken(token);
  first.ledger.grant({ accountId, credits: 4, reason: '测试' });
  first.reserveForTask(accountId, 'completed-task');
  first.reserveForTask(accountId, 'missing-task');

  const second = createBilling({ config: billingConfig(dir) });
  second.attachTasks({
    peek: (id) => (id === 'completed-task' ? { id, status: 'completed', updated: Date.now() } : null),
    list: () => [],
  });
  assert.equal(second.wallet(accountId).available, 3);
  assert.equal(second.wallet(accountId).reserved, 0);
  const types = second.ledger._all().map((entry) => entry.type);
  assert.ok(types.includes('consume'));
  assert.ok(types.includes('release'));
});

test('状态不确定时先保留额度，超过保留时间后释放', () => {
  const dir = tempDir();
  let clock = 1_000_000;
  const billing = createBilling({
    config: billingConfig(dir, { uncertainHoldMinutes: 0.01 }),
    now: () => clock,
    imageTasks: { peek: (id) => ({ id, status: 'uncertain', updated: 1 }), list: () => [] },
  });
  const { token } = billing.createAccount({});
  const accountId = billing.accountFromToken(token);
  billing.ledger.grant({ accountId, credits: 1, reason: '测试' });
  billing.reserveForTask(accountId, 'shaky');
  billing.settle('shaky', 'uncertain');
  assert.equal(billing.wallet(accountId).reserved, 1);
  clock += 60_000;
  billing.reconcile();
  assert.equal(billing.wallet(accountId).reserved, 0);
  assert.equal(billing.wallet(accountId).available, 1);
});

/* ----------------------------------------
 * HTTP 端到端与越权
 * ---------------------------------------- */

async function withApp(envOverrides, fn, appOptions = {}) {
  const dataDir = tempDir('vc-bill-http-');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    STATIC_ROOT: path.join(process.cwd(), 'public'),
    BILLING_ENABLED: 'true',
    BILLING_PROVIDER: 'mock',
    BILLING_ACCOUNT_SECRET: SECRET,
    BILLING_PRODUCTS: JSON.stringify([{ id: 'starter', title: '体验包', priceFen: 990, credits: 3, creditValidDays: 90, description: '3 张 AI 配图' }]),
    ADMIN_TOKEN: 'admin-token-1234567890',
    ...envOverrides,
  });
  assert.equal(config.ok, true, config.errors.join('; '));
  const app = createApp({
    imageService: async () => ({ data: Buffer.from('fake-image'), mime: 'image/png', requestId: 'fake' }),
    ...appOptions,
  }, config, createTelemetry({ dataDir, enabled: false }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { return await fn(base, { dataDir, config }); }
  finally { await new Promise((resolve) => app.close(resolve)); }
}

const json = (base, url, { method = 'GET', token, admin, body, headers = {} } = {}) => fetch(base + url, {
  method,
  headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { 'X-Billing-Token': token } : {}),
    ...(admin ? { 'X-Admin-Token': admin } : {}),
    ...headers,
  },
  body: body ? JSON.stringify(body) : undefined,
});

async function createAccount(base) {
  const response = await fetch(base + '/api/billing/account', { method: 'POST' });
  assert.equal(response.status, 201);
  return response.json();
}

async function payOrder(base, token, productId = 'starter') {
  const created = await json(base, '/api/billing/orders', { method: 'POST', token, body: { productId } });
  assert.equal(created.status, 201);
  const data = await created.json();
  const page = await fetch(base + data.payUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  const sign = html.match(/name="sign" value="([^"]+)"/)[1];
  const outTradeNo = html.match(/name="out_trade_no" value="([^"]+)"/)[1];
  const completed = await fetch(base + '/api/billing/mock/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ out_trade_no: outTradeNo, sign, action: 'pay' }),
    redirect: 'manual',
  });
  assert.equal(completed.status, 303);
  const fresh = await (await json(base, `/api/billing/orders/${outTradeNo}`, { token })).json();
  return fresh.order;
}

test('HTTP 全流程：开户 → 下单 → 模拟支付 → 额度到账 → 配图预占与消耗', async () => {
  await withApp({}, async (base) => {
    const configBody = await (await fetch(base + '/api/billing/config')).json();
    assert.equal(configBody.enabled, true);
    assert.equal(configBody.products[0].price, '9.90');
    assert.equal(configBody.products[0].validity, '购买后 90 天内有效');

    const account = await createAccount(base);
    assert.equal(account.balance.available, 0);
    const order = await payOrder(base, account.token);
    assert.equal(order.status, 'paid');

    const wallet = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(wallet.available, 3);

    const taskResponse = await json(base, '/api/image-tasks', {
      method: 'POST', token: account.token, body: { idempotencyKey: crypto.randomUUID(), prompt: 'guitar poster' },
    });
    assert.equal(taskResponse.status, 202);
    const task = await taskResponse.json();

    let state;
    for (let i = 0; i < 40; i++) {
      state = await (await json(base, `/api/image-tasks/${task.id}`, { token: account.token })).json();
      if (state.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(state.status, 'completed');

    const after = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(after.available, 2);
    assert.equal(after.usage.filter((entry) => entry.type === 'reserve').length, 1);
    assert.equal(after.usage.filter((entry) => entry.type === 'consume').length, 1);
  });
});

test('HTTP：没有额度账户或额度不足时，配图请求被拒且不扣额度', async () => {
  await withApp({}, async (base) => {
    const noToken = await json(base, '/api/image-tasks', { method: 'POST', body: { idempotencyKey: crypto.randomUUID(), prompt: 'x' } });
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).code, 'BILLING_TOKEN_REQUIRED');

    const account = await createAccount(base);
    const poor = await json(base, '/api/image-tasks', {
      method: 'POST', token: account.token, body: { idempotencyKey: crypto.randomUUID(), prompt: 'x' },
    });
    assert.equal(poor.status, 402);
    assert.equal((await poor.json()).code, 'INSUFFICIENT_CREDITS');

    const wallet = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(wallet.available, 0);
    assert.equal(wallet.reserved, 0);
  });
});

test('HTTP：重复支付通知与重复完成支付都不会重复发放', async () => {
  await withApp({}, async (base) => {
    const account = await createAccount(base);
    const order = await payOrder(base, account.token);
    const notify = mockNotify(order.outTradeNo, 990);
    const send = () => fetch(base + '/api/billing/notify/mock', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(notify),
    });
    assert.equal(await (await send()).text(), 'success');
    assert.equal(await (await send()).text(), 'success');
    const wallet = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(wallet.available, 3);
  });
});

test('HTTP：金额被篡改的通知返回 failure，额度不变', async () => {
  await withApp({}, async (base) => {
    const account = await createAccount(base);
    const created = await json(base, '/api/billing/orders', { method: 'POST', token: account.token, body: { productId: 'starter' } });
    const order = (await created.json()).order;
    const notify = mockNotify(order.outTradeNo, 1);
    const response = await fetch(base + '/api/billing/notify/mock', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(notify),
    });
    assert.equal(await response.text(), 'failure');
    const wallet = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(wallet.available, 0);
  });
});

test('HTTP：订单归属校验，别人的订单查不到', async () => {
  await withApp({}, async (base) => {
    const alice = await createAccount(base);
    const bob = await createAccount(base);
    const order = await payOrder(base, alice.token);
    const own = await json(base, `/api/billing/orders/${order.outTradeNo}`, { token: alice.token });
    assert.equal(own.status, 200);
    const other = await json(base, `/api/billing/orders/${order.outTradeNo}`, { token: bob.token });
    assert.equal(other.status, 404);
    const list = await (await json(base, '/api/billing/orders', { token: bob.token })).json();
    assert.deepEqual(list.orders, []);
  });
});

test('HTTP：运营接口鉴权、暂停生成、调整额度、退款与审计', async () => {
  await withApp({}, async (base) => {
    const account = await createAccount(base);
    const order = await payOrder(base, account.token);

    const noToken = await fetch(base + '/api/admin/orders');
    assert.equal(noToken.status, 401);
    const userToken = await fetch(base + '/api/admin/orders', { headers: { 'X-Admin-Token': account.token } });
    assert.equal(userToken.status, 401);

    const admin = { 'X-Admin-Token': 'admin-token-1234567890' };
    const orders = await (await fetch(base + '/api/admin/orders', { headers: admin })).json();
    assert.equal(orders.orders.length, 1);
    assert.equal(orders.orders[0].accountId, account.accountId);

    const paused = await fetch(base + '/api/admin/pause', {
      method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true, reason: '演练暂停' }),
    });
    assert.equal(paused.status, 200);
    const blocked = await json(base, '/api/image-tasks', {
      method: 'POST', token: account.token, body: { idempotencyKey: crypto.randomUUID(), prompt: 'x' },
    });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, 'GENERATION_PAUSED');

    await fetch(base + '/api/admin/pause', {
      method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false }),
    });

    const adjusted = await fetch(base + '/api/admin/credits/adjust', {
      method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: account.accountId, credits: 2, reason: '客服补偿' }),
    });
    assert.equal(adjusted.status, 200);
    let wallet = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(wallet.available, 5);

    const refund = await fetch(base + `/api/admin/orders/${order.outTradeNo}/refund`, {
      method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '用户申请退款' }),
    });
    assert.equal(refund.status, 200);
    const refundBody = await refund.json();
    assert.equal(refundBody.refund.removed, 3);
    assert.equal(refundBody.refund.shortfall, 0);
    wallet = await (await json(base, '/api/billing/wallet', { token: account.token })).json();
    assert.equal(wallet.available, 2);

    const audit = await (await fetch(base + '/api/admin/audit', { headers: admin })).json();
    const actions = audit.audit.map((entry) => entry.action);
    assert.ok(actions.includes('pause_generation'));
    assert.ok(actions.includes('resume_generation'));
    assert.ok(actions.includes('adjust_credits'));
    assert.ok(actions.includes('refund_credits'));
    assert.ok(audit.audit.every((entry) => entry.action !== 'adjust_credits' || entry.detail.reason === '客服补偿'));
  });
});

test('HTTP：已支付订单再次查单直接返回已支付，不再调用渠道', async () => {
  await withApp({}, async (base) => {
    const account = await createAccount(base);
    const order = await payOrder(base, account.token);
    const refreshed = await (await json(base, `/api/billing/orders/${order.outTradeNo}?refresh=1`, { token: account.token })).json();
    assert.equal(refreshed.order.status, 'paid');
    assert.equal(refreshed.query.checked, false);
  });
});

/* ----------------------------------------
 * 支付宝渠道（临时 RSA 密钥，不连真实网关）
 * ---------------------------------------- */

function alipayFixture(fetchImpl = fetch) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const provider = createAlipayProvider({
    appId: '2021000000000001',
    privateKey: privatePem,
    publicKey: publicPem,
    gateway: 'https://openapi-sandbox.example.com/gateway.do',
    notifyUrl: 'https://canvas.example.com/api/billing/notify/alipay',
    returnUrl: 'https://canvas.example.com/',
    fetchImpl,
    now: () => 1_793_000_000_000,
  });
  return { provider, privatePem, publicPem };
}

function signedNotify(privatePem, overrides = {}) {
  const params = {
    app_id: '2021000000000001',
    out_trade_no: 'VC20261030000000ABCDEF01',
    total_amount: '9.90',
    trade_status: 'TRADE_SUCCESS',
    trade_no: '2026103022001400000000000001',
    notify_time: '2026-10-30 12:00:00',
    sign_type: 'RSA2',
    ...overrides,
  };
  params.sign = signRSA2(signContent(params), privatePem);
  return params;
}

function gatewayResponse(node, privatePem, { sign = true } = {}) {
  const rawNode = JSON.stringify(node);
  const body = { alipay_trade_query_response: node };
  if (sign) body.sign = signRSA2(rawNode, privatePem);
  return `{"alipay_trade_query_response":${rawNode}${sign ? `,"sign":${JSON.stringify(body.sign)}` : ''}}`;
}

test('支付宝下单参数用 RSA2 签名，金额只来自订单', () => {
  const { provider, publicPem } = alipayFixture();
  const { payUrl } = provider.createPayment({
    outTradeNo: 'VC20261030000000ABCDEF01',
    amountFen: 990,
    productTitle: '体验包',
    expiresAt: 1_793_000_000_000 + 30 * 60_000,
  });
  const url = new URL(payUrl);
  const params = Object.fromEntries(url.searchParams);
  assert.equal(params.method, 'alipay.trade.page.pay');
  assert.equal(params.sign_type, 'RSA2');
  const biz = JSON.parse(params.biz_content);
  assert.equal(biz.total_amount, '9.90');
  assert.equal(biz.out_trade_no, 'VC20261030000000ABCDEF01');
  assert.equal(biz.subject, '体验包');
  assert.equal(crypto.createVerify('RSA-SHA256').update(signContent(params)).verify(publicPem, params.sign, 'base64'), true);
  assert.equal(params.notify_url, 'https://canvas.example.com/api/billing/notify/alipay');
});

test('支付宝通知：验签通过才采信，改金额或改状态都会被识破', () => {
  const { provider, privatePem } = alipayFixture();
  const ok = provider.verifyNotify(signedNotify(privatePem));
  assert.equal(ok.ok, true);
  assert.equal(ok.amountFen, 990);
  assert.equal(ok.orderNo, 'VC20261030000000ABCDEF01');

  const tampered = signedNotify(privatePem);
  tampered.total_amount = '0.01';
  assert.equal(provider.verifyNotify(tampered).ok, false);

  const waiting = provider.verifyNotify(signedNotify(privatePem, { trade_status: 'WAIT_BUYER_PAY' }));
  assert.equal(waiting.ok, false);
  assert.equal(waiting.notPaid, true);

  const wrongApp = provider.verifyNotify(signedNotify(privatePem, { app_id: '2021000000000002' }));
  assert.equal(wrongApp.ok, false);
});

test('支付宝查单：响应节点验签，未签名或签名不符都不采信', async () => {
  let body = '';
  const { provider, privatePem } = alipayFixture(async () => ({ ok: true, text: async () => body }));
  const order = { outTradeNo: 'VC20261030000000ABCDEF01', amountFen: 990 };
  const paidNode = {
    code: '10000', out_trade_no: order.outTradeNo, total_amount: '9.90',
    trade_status: 'TRADE_SUCCESS', trade_no: '2026103022001400000000000001',
  };

  body = gatewayResponse(paidNode, privatePem);
  assert.deepEqual(await provider.query(order), {
    status: 'paid', amountFen: 990, tradeNo: '2026103022001400000000000001', currency: 'CNY',
  });

  body = gatewayResponse(paidNode, privatePem, { sign: false });
  await assert.rejects(provider.query(order), { code: 'PROVIDER_SIGNATURE_MISSING' });

  body = gatewayResponse({ ...paidNode, total_amount: '9900.00' }, privatePem);
  await assert.rejects(provider.query(order), { code: 'AMOUNT_MISMATCH' });

  // 节点被改、签名还是旧的：验签必须失败。
  body = gatewayResponse(paidNode, privatePem).replace('"9.90"', '"0.01"');
  await assert.rejects(provider.query(order), { code: 'PROVIDER_SIGNATURE_INVALID' });

  body = gatewayResponse({ code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }, privatePem);
  assert.deepEqual(await provider.query(order), { status: 'pending' });

  body = gatewayResponse({ code: '40004', sub_code: 'ACQ.SYSTEM_ERROR', sub_msg: '系统繁忙' }, privatePem);
  await assert.rejects(provider.query(order), { code: 'PROVIDER_QUERY_FAILED' });
});

/* ----------------------------------------
 * 配置
 * ---------------------------------------- */

test('配置：生产环境禁止模拟渠道，商品表不合法则拒绝启动', () => {
  const base = {
    NODE_ENV: 'production', APP_ORIGIN: 'https://canvas.example.com',
    STATIC_ROOT: path.join(process.cwd(), 'public'), DATA_DIR: path.join(process.cwd(), 'data'),
    BEHIND_TLS_PROXY: 'true', TRIAL_ALLOWED_EMAILS: 'insider@example.com', BILLING_ENABLED: 'true',
    BILLING_PROVIDER: 'mock', BILLING_ACCOUNT_SECRET: SECRET,
    BILLING_PRODUCTS: JSON.stringify([{ id: 'starter', title: '体验包', priceFen: 990, credits: 3, creditValidDays: 90 }]),
  };
  const mock = loadConfig(base);
  assert.ok(mock.errors.some((line) => line.includes('模拟支付渠道')));

  const bad = loadConfig({ ...base, BILLING_PROVIDER: 'alipay', BILLING_PRODUCTS: '[{"id":"x","title":"","priceFen":0,"credits":0}]' });
  assert.ok(bad.errors.some((line) => line.includes('priceFen')));
  assert.ok(bad.errors.some((line) => line.includes('credits')));
  assert.ok(bad.errors.some((line) => line.includes('title')));
  assert.ok(bad.errors.some((line) => line.includes('ALIPAY_APP_ID')));
});

test('配置：付费关闭时商品表可以不填', () => {
  const config = loadConfig({ DATA_DIR: tempDir(), STATIC_ROOT: 'public' });
  assert.equal(config.billing.enabled, false);
  assert.deepEqual(config.billing.products, []);
  assert.deepEqual(config.errors, []);
});
