'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLedger } = require('./ledger');
const { createOrders } = require('./orders');
const { createAccounts } = require('./accounts');
const { createAudit } = require('./audit');
const { createMockProvider } = require('./providers/mock');
const { createAlipayProvider } = require('./providers/alipay');

/* ----------------------------------------
 * 付费闭环的组装层
 *
 * 账户（谁）、订单（买了什么）、流水（额度怎么变的）、渠道（钱怎么收）分开写，
 * 这里只做编排，并守住三条线：
 *
 *   1. 金额和商品只从服务端商品表取，浏览器传什么都不看；
 *   2. 只有验签通过的支付通知、或验签通过的主动查单，才能把订单标成已支付；
 *   3. 发货以流水为准：同一订单已经有一条 purchase，就不会再发第二次。
 * ---------------------------------------- */

const STATUS_TEXT = { pending: '待支付', paid: '已支付', closed: '已关闭', refunded: '已退款' };
const USAGE_TEXT = {
  grant: '赠送', purchase: '购买', reserve: '生成预占', consume: '生成消耗',
  release: '释放预占', expire: '过期', adjust: '运营调整', refund: '退款收回',
};

function formatFen(fen) {
  return (Number(fen) / 100).toFixed(2);
}

function productView(product) {
  return {
    id: product.id,
    title: product.title,
    description: product.description || '',
    priceFen: product.priceFen,
    price: formatFen(product.priceFen),
    credits: product.credits,
    creditValidDays: product.creditValidDays,
    validity: product.creditValidDays > 0 ? `购买后 ${product.creditValidDays} 天内有效` : '长期有效',
    unit: '张 AI 配图',
  };
}

function orderView(order) {
  return {
    outTradeNo: order.outTradeNo,
    productId: order.productId,
    productTitle: order.productTitle,
    amountFen: order.amountFen,
    amount: formatFen(order.amountFen),
    credits: order.credits,
    creditValidDays: order.creditValidDays,
    currency: order.currency,
    status: order.status,
    statusText: STATUS_TEXT[order.status] || order.status,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    note: order.note || null,
    refund: order.refund
      ? { at: order.refund.at, reason: order.refund.reason, removed: order.refund.removed, shortfall: order.refund.shortfall }
      : null,
  };
}

function adminOrderView(order) {
  return {
    ...orderView(order),
    accountId: order.accountId,
    provider: order.provider,
    providerTradeNo: order.providerTradeNo,
  };
}

function usageView(entry) {
  return {
    id: entry.id,
    at: entry.at,
    type: entry.type,
    typeText: USAGE_TEXT[entry.type] || entry.type,
    credits: entry.credits,
    taskId: entry.taskId,
    orderId: entry.orderId,
    reason: entry.reason,
  };
}

function loadOrCreateSecret(dir) {
  const file = path.join(dir, 'account-secret');
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

function createBilling({
  config,
  logger = console,
  now = () => Date.now(),
  provider: providerOverride = null,
  accountSecret = null,
  imageTasks = null,
} = {}) {
  const settings = config.billing;
  if (!settings || !settings.enabled) return disabledBilling();

  const dir = settings.dir;
  fs.mkdirSync(dir, { recursive: true });
  const secret = accountSecret || settings.accountSecret || loadOrCreateSecret(dir);
  const accounts = createAccounts({ dir, secret, now, logger });
  const ledger = createLedger({ dir, now, logger });
  const orders = createOrders({ dir, ledger, now, logger });
  const audit = createAudit({ dir, now, logger });

  const provider = providerOverride || makeProvider({ settings, config, secret, logger, now });

  const pausedFile = path.join(dir, 'runtime.json');
  let runtime = { paused: false, reason: null, actor: null, at: null };
  try {
    if (fs.existsSync(pausedFile)) runtime = { ...runtime, ...JSON.parse(fs.readFileSync(pausedFile, 'utf8')) };
  } catch (err) {
    logger.warn({ event: 'billing_runtime_load_failed', error: err.message });
  }

  function saveRuntime() {
    const tmp = pausedFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(runtime));
    fs.renameSync(tmp, pausedFile);
  }

  let tasksRef = imageTasks;
  const uncertainTimers = new Set();

  function catalog() {
    return {
      enabled: true,
      provider: provider.name,
      currency: 'CNY',
      creditsPerTask: settings.creditsPerTask,
      signupGrantCredits: settings.signupGrantCredits,
      products: settings.products.map(productView),
      paused: runtime.paused === true,
      orderTtlMinutes: settings.orderTtlMinutes,
    };
  }

  function accountFromToken(token) {
    return token ? accounts.verify(token) : null;
  }

  function createAccount({ ip = null, token = null } = {}) {
    const existing = token ? accounts.verify(token) : null;
    if (existing) {
      return { token, accountId: existing, balance: ledger.balance(existing), created: false };
    }
    const { account, token: issued } = accounts.create({ ip });
    if (settings.signupGrantCredits > 0) {
      ledger.grant({
        accountId: account.id,
        credits: settings.signupGrantCredits,
        expiresAt: settings.signupGrantValidDays > 0 ? now() + settings.signupGrantValidDays * 86_400_000 : null,
        reason: '新账户赠送',
        type: 'grant',
        lotId: `signup:${account.id}`,
      });
    }
    audit.record({ actor: 'system', action: 'account_created', target: account.id, ip });
    return { token: issued, accountId: account.id, balance: ledger.balance(account.id), created: true };
  }

  function wallet(accountId) {
    const balance = ledger.balance(accountId);
    return {
      available: balance.available,
      reserved: balance.reserved,
      lots: balance.lots.map((lot) => ({
        lotId: lot.lotId,
        credits: lot.credits,
        remaining: lot.remaining,
        expiresAt: lot.expiresAt,
        at: lot.at,
        reason: lot.reason,
        orderId: lot.orderId,
      })),
      usage: ledger.usage(accountId, 30).map(usageView),
    };
  }

  function applyExpiry(order) {
    if (order && order.status === 'pending' && now() > order.expiresAt) {
      orders.close(order, '超时未支付，订单已关闭');
    }
    return order;
  }

  function createOrder(accountId, productId) {
    const product = settings.products.find((item) => item.id === productId);
    if (!product) throw Object.assign(new Error('商品不存在，请刷新页面后重试。'), { status: 400, code: 'PRODUCT_NOT_FOUND' });
    const order = orders.create({ accountId, product, ttlMinutes: settings.orderTtlMinutes });
    let payUrl;
    try {
      const result = provider.createPayment(order, {
        notifyUrl: notifyUrlFor(provider.name),
        returnUrl: settings.returnUrl || (config.appOrigin ? `${config.appOrigin}/` : null),
      });
      payUrl = result.payUrl;
    } catch (err) {
      orders.close(order, '创建支付失败：' + err.message);
      logger.error({ event: 'billing_create_payment_failed', order: order.outTradeNo, error: err.message });
      throw Object.assign(new Error('暂时无法发起支付，请稍后重试。'), { status: 502, code: 'PAYMENT_CREATE_FAILED' });
    }
    logger.info({ event: 'billing_order_created', order: order.outTradeNo, productId: product.id, amountFen: order.amountFen });
    return { order: orderView(order), payUrl };
  }

  function notifyUrlFor(name) {
    if (name === 'alipay') {
      return settings.alipay.notifyUrl || (config.appOrigin ? `${config.appOrigin}/api/billing/notify/alipay` : '');
    }
    if (name === 'mock') {
      return config.appOrigin ? `${config.appOrigin}/api/billing/notify/mock` : '';
    }
    return '';
  }

  function listOrders(accountId, limit = 20) {
    return orders.list(accountId, limit).map((order) => orderView(applyExpiry(order)));
  }

  function getOrder(accountId, outTradeNo) {
    const order = orders.get(outTradeNo);
    if (!order || order.accountId !== accountId) return null;
    return orderView(applyExpiry(order));
  }

  async function refreshOrder(accountId, outTradeNo) {
    const order = orders.get(outTradeNo);
    if (!order || order.accountId !== accountId) return null;
    applyExpiry(order);
    if (order.status === 'paid' || order.status === 'refunded') {
      return { order: orderView(order), query: { checked: false, paid: order.status === 'paid' } };
    }
    try {
      const result = await provider.query(order);
      if (result.status === 'paid') {
        const settled = orders.markPaid(order, {
          amountFen: result.amountFen,
          currency: result.currency || order.currency,
          tradeNo: result.tradeNo || null,
          paidAt: null,
          provider: provider.name,
        });
        audit.record({
          actor: 'provider:' + provider.name,
          action: 'order_query_paid',
          target: order.outTradeNo,
          detail: { already: settled.already },
        });
        return { order: orderView(order), query: { checked: true, paid: true, already: settled.already } };
      }
      return { order: orderView(order), query: { checked: true, paid: false } };
    } catch (err) {
      logger.warn({ event: 'billing_query_failed', order: order.outTradeNo, code: err.code || null, error: err.message });
      return {
        order: orderView(order),
        query: { checked: true, paid: false, error: '暂时查不到支付结果，请稍后再查或查看订单状态。' },
      };
    }
  }

  function handleNotify(name, params) {
    if (name !== provider.name) {
      return { ok: false, reason: 'PAYMENT_PROVIDER_MISMATCH', httpStatus: 400 };
    }
    let verified;
    try {
      verified = provider.verifyNotify(params || {});
    } catch (err) {
      verified = { ok: false, reason: '通知解析失败：' + err.message };
    }
    if (!verified.ok) {
      if (verified.notPaid) {
        audit.record({ actor: 'provider:' + name, action: 'notify_ignored', target: params?.out_trade_no || null, detail: { reason: verified.reason } });
        return { ok: false, reason: 'TRADE_NOT_PAID' };
      }
      audit.record({ actor: 'provider:' + name, action: 'notify_rejected', target: params?.out_trade_no || null, detail: { reason: verified.reason } });
      logger.warn({ event: 'billing_notify_rejected', provider: name, reason: verified.reason });
      return { ok: false, reason: 'SIGNATURE_INVALID' };
    }
    const order = orders.get(verified.orderNo);
    if (!order) {
      audit.record({ actor: 'provider:' + name, action: 'notify_rejected', target: verified.orderNo, detail: { reason: '订单不存在' } });
      return { ok: false, reason: 'ORDER_NOT_FOUND' };
    }
    try {
      const settled = orders.markPaid(order, {
        amountFen: verified.amountFen,
        currency: verified.currency || order.currency,
        tradeNo: verified.tradeNo || null,
        paidAt: verified.paidAt || null,
        provider: name,
      });
      audit.record({
        actor: 'provider:' + name,
        action: 'notify_accepted',
        target: order.outTradeNo,
        detail: { already: settled.already, amountFen: verified.amountFen, providerTradeNo: verified.tradeNo || null },
      });
      logger.info({ event: 'billing_notify_accepted', order: order.outTradeNo, already: settled.already });
      return { ok: true, already: settled.already, order: orderView(order) };
    } catch (err) {
      audit.record({
        actor: 'provider:' + name,
        action: 'notify_rejected',
        target: order.outTradeNo,
        detail: { reason: err.message, code: err.code || null },
      });
      logger.warn({ event: 'billing_notify_mismatch', order: order.outTradeNo, code: err.code || null, error: err.message });
      return { ok: false, reason: err.code || 'SETTLE_FAILED' };
    }
  }

  function assertCanAfford(accountId) {
    const balance = ledger.balance(accountId);
    if (balance.available < settings.creditsPerTask) {
      throw Object.assign(
        new Error(`额度不足：本次配图需要 ${settings.creditsPerTask} 额度，当前可用 ${balance.available}。请先购买额度。`),
        { status: 402, code: 'INSUFFICIENT_CREDITS', available: balance.available, need: settings.creditsPerTask },
      );
    }
    return true;
  }

  function reserveForTask(accountId, taskId) {
    return ledger.reserve({ accountId, taskId, credits: settings.creditsPerTask, reason: 'AI 配图预占' });
  }

  function settle(taskId, status) {
    if (!taskId) return null;
    if (status === 'completed') return ledger.consume({ taskId, reason: '配图生成成功' });
    if (status === 'failed' || status === 'cancelled') return ledger.release({ taskId, reason: status === 'cancelled' ? '任务取消，释放预占' : '生成失败，释放预占' });
    if (status === 'uncertain') {
      scheduleUncertainRelease(taskId);
      return { taskId, held: true };
    }
    return null;
  }

  function scheduleUncertainRelease(taskId) {
    const key = String(taskId);
    if (uncertainTimers.has(key)) return;
    const delay = Math.max(1000, settings.uncertainHoldMinutes * 60_000);
    const timer = setTimeout(() => {
      uncertainTimers.delete(key);
      const reservation = ledger.openReservations().find((item) => item.taskId === key);
      if (!reservation) return;
      const task = tasksRef && typeof tasksRef.peek === 'function' ? tasksRef.peek(key) : null;
      if (task && task.status !== 'uncertain') {
        settle(key, task.status);
        return;
      }
      ledger.release({ taskId: key, reason: `供应商状态不确定超过 ${settings.uncertainHoldMinutes} 分钟，释放预占` });
      audit.record({ actor: 'system', action: 'uncertain_released', target: key, detail: { holdMinutes: settings.uncertainHoldMinutes } });
    }, delay);
    if (timer.unref) timer.unref();
    uncertainTimers.add(key);
  }

  /**
   * 启动时对账：把流水里的每一笔预占和任务状态对一遍。
   * 任务没了、失败了、取消了 → 退回额度；已完成 → 记消耗；
   * 状态不确定且已经超过保留时间 → 退回额度。
   */
  function reconcile() {
    const summary = { released: 0, consumed: 0, kept: 0 };
    if (!tasksRef || typeof tasksRef.peek !== 'function') return summary;
    for (const reservation of ledger.openReservations()) {
      const task = tasksRef.peek(reservation.taskId);
      if (!task) {
        ledger.release({ taskId: reservation.taskId, reason: '任务记录已清理，释放预占' });
        summary.released++;
        continue;
      }
      if (task.status === 'completed') {
        ledger.consume({ taskId: reservation.taskId, reason: '重启对账：任务已完成' });
        summary.consumed++;
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        ledger.release({ taskId: reservation.taskId, reason: '重启对账：任务未完成' });
        summary.released++;
      } else if (task.status === 'uncertain' && now() - (task.updated || 0) > settings.uncertainHoldMinutes * 60_000) {
        ledger.release({ taskId: reservation.taskId, reason: '重启对账：供应商状态不确定已超时' });
        summary.released++;
      } else {
        if (task.status === 'uncertain') scheduleUncertainRelease(reservation.taskId);
        summary.kept++;
      }
    }
    if (summary.released || summary.consumed) logger.info({ event: 'billing_reconciled', ...summary });
    return summary;
  }

  function attachTasks(tasks) {
    tasksRef = tasks;
    return reconcile();
  }

  function isPaused() {
    return runtime.paused === true;
  }

  function pause({ reason, actor = 'admin', ip = null }) {
    if (!reason) throw Object.assign(new Error('暂停生成必须写明原因。'), { status: 400 });
    runtime = { paused: true, reason, actor, at: now() };
    saveRuntime();
    audit.record({ actor, action: 'pause_generation', target: null, detail: { reason }, ip });
    return { ...runtime };
  }

  function resume({ actor = 'admin', ip = null }) {
    runtime = { paused: false, reason: null, actor, at: now() };
    saveRuntime();
    audit.record({ actor, action: 'resume_generation', target: null, ip });
    return { ...runtime };
  }

  function adminOrders({ status = null, limit = 50 } = {}) {
    return orders.listAll({ status, limit }).map((order) => adminOrderView(applyExpiry(order)));
  }

  function adminOrder(outTradeNo) {
    const order = orders.get(outTradeNo);
    return order ? adminOrderView(applyExpiry(order)) : null;
  }

  function adminTasks(limit = 30) {
    if (!tasksRef || typeof tasksRef.list !== 'function') return [];
    return tasksRef.list(limit);
  }

  function adminAccount(accountId) {
    const account = accounts.get(accountId);
    if (!account) return null;
    return {
      accountId: account.id,
      createdAt: account.createdAt,
      ...wallet(accountId),
      orders: orders.list(accountId, 20).map((order) => adminOrderView(order)),
    };
  }

  function adjustCredits({ accountId, credits, reason, actor = 'admin', ip = null }) {
    if (!accounts.get(accountId)) throw Object.assign(new Error('账户不存在。'), { status: 404 });
    if (!Number.isInteger(credits) || credits === 0) throw Object.assign(new Error('调整额度必须是非零整数。'), { status: 400 });
    if (!reason) throw Object.assign(new Error('调整额度必须写明原因。'), { status: 400 });
    const result = ledger.adjust({ accountId, credits, reason, actor });
    audit.record({ actor, action: 'adjust_credits', target: accountId, detail: { credits, reason, ...result }, ip });
    return { ...result, balance: ledger.balance(accountId) };
  }

  function refundOrder({ outTradeNo, reason, actor = 'admin', ip = null }) {
    if (!reason) throw Object.assign(new Error('退款必须写明原因。'), { status: 400 });
    const order = orders.get(outTradeNo);
    if (!order) throw Object.assign(new Error('订单不存在。'), { status: 404 });
    const result = orders.refund(order, { reason, actor });
    audit.record({
      actor,
      action: result.already ? 'refund_repeated' : 'refund_credits',
      target: outTradeNo,
      detail: { reason, removed: result.refund.removed, shortfall: result.refund.shortfall },
      ip,
    });
    return { order: adminOrderView(order), refund: result.refund, already: result.already };
  }

  return {
    enabled: true,
    providerName: provider.name,
    accounts,
    ledger,
    orders,
    audit,
    provider,
    catalog,
    accountFromToken,
    createAccount,
    wallet,
    createOrder,
    listOrders,
    getOrder,
    refreshOrder,
    handleNotify,
    assertCanAfford,
    reserveForTask,
    settle,
    reconcile,
    attachTasks,
    isPaused,
    pause,
    resume,
    runtime: () => ({ ...runtime }),
    adminOrders,
    adminOrder,
    adminTasks,
    adminAccount,
    adjustCredits,
    refundOrder,
    creditsPerTask: settings.creditsPerTask,
    uncertaintyHoldMinutes: settings.uncertainHoldMinutes,
  };
}

function makeProvider({ settings, config, secret, logger, now }) {
  if (settings.provider === 'mock') {
    return createMockProvider({
      secret: crypto.createHmac('sha256', secret).update('vibecanvas-mock-provider').digest('hex'),
      dir: settings.dir,
      logger,
      now,
    });
  }
  return createAlipayProvider({
    appId: settings.alipay.appId,
    privateKey: settings.alipay.privateKey || settings.alipay.privateKeyPath,
    publicKey: settings.alipay.publicKey || settings.alipay.publicKeyPath,
    gateway: settings.alipay.gateway,
    notifyUrl: settings.alipay.notifyUrl,
    returnUrl: settings.alipay.returnUrl,
    sellerId: settings.alipay.sellerId,
    allowInsecure: !config.production,
    now,
  });
}

function disabledBilling() {
  const off = () => {
    throw Object.assign(new Error('付费功能未开启。'), { status: 404, code: 'BILLING_DISABLED' });
  };
  return {
    enabled: false,
    providerName: null,
    catalog: () => ({ enabled: false }),
    accountFromToken: () => null,
    createAccount: off,
    wallet: off,
    createOrder: off,
    listOrders: () => [],
    getOrder: () => null,
    refreshOrder: async () => null,
    handleNotify: () => ({ ok: false, reason: 'BILLING_DISABLED' }),
    assertCanAfford: () => true,
    reserveForTask: () => null,
    settle: () => null,
    reconcile: () => ({}),
    attachTasks: () => ({}),
    isPaused: () => false,
    pause: off,
    resume: off,
    runtime: () => ({ paused: false }),
    adminOrders: () => [],
    adminOrder: () => null,
    adminTasks: () => [],
    adminAccount: () => null,
    adjustCredits: off,
    refundOrder: off,
    creditsPerTask: 0,
    uncertaintyHoldMinutes: 0,
  };
}

module.exports = { createBilling, formatFen, productView, orderView, STATUS_TEXT, USAGE_TEXT };
