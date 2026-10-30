'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ----------------------------------------
 * 订单
 *
 * 订单里的金额、商品名、额度数量全部来自服务端商品表，
 * 浏览器只传 productId，传价格也不会被采用。
 *
 * 只有两条路能把订单变成 paid：
 *   1. 服务端验证过签名的支付通知；
 *   2. 服务端主动查单，供应商明确说已支付。
 * 支付成功后的跳转页不参与发货。
 *
 * 发货（写 purchase 流水）与订单状态分开判断：
 * 先看流水里有没有这个订单的 purchase，有就跳过——
 * 所以重复通知、重启后重放、查单与通知同时到达，都只会发一次额度。
 * ---------------------------------------- */

const STATUSES = new Set(['pending', 'paid', 'closed', 'refunded']);

function createOrders({ dir, ledger, now = () => Date.now(), logger = console } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'orders.json');
  const state = { version: 1, orders: {} };

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.orders && typeof data.orders === 'object') state.orders = data.orders;
    } catch (err) {
      logger.warn({ event: 'orders_load_failed', error: err.message });
    }
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function nextNo() {
    const date = new Date(now());
    const stamp = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return 'VC' + stamp + crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  function create({ accountId, product, ttlMinutes }) {
    const at = now();
    const order = {
      outTradeNo: nextNo(),
      accountId,
      productId: product.id,
      productTitle: product.title,
      amountFen: product.priceFen,
      credits: product.credits,
      creditValidDays: product.creditValidDays,
      currency: 'CNY',
      status: 'pending',
      createdAt: at,
      expiresAt: at + Math.max(1, ttlMinutes) * 60_000,
      paidAt: null,
      providerTradeNo: null,
      provider: null,
      note: null,
      refund: null,
    };
    state.orders[order.outTradeNo] = order;
    save();
    return order;
  }

  function get(outTradeNo) {
    return state.orders[String(outTradeNo)] || null;
  }

  function list(accountId, limit = 20) {
    return Object.values(state.orders)
      .filter((order) => order.accountId === accountId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  function listAll({ status, limit = 50 } = {}) {
    return Object.values(state.orders)
      .filter((order) => !status || order.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(Math.max(limit, 1), 500));
  }

  /**
   * 由「已验签的通知」或「主动查单结果是已支付」调用。
   * 返回 already=true 表示这单此前已经发过额度，本次什么都没做。
   */
  function markPaid(order, { amountFen, currency, tradeNo = null, paidAt = null, provider = null }) {
    if (!order) throw Object.assign(new Error('订单不存在。'), { status: 404 });
    if (currency !== order.currency) {
      throw Object.assign(new Error(`币种不符：订单 ${order.currency}，通知 ${currency}。`), { status: 409, code: 'CURRENCY_MISMATCH' });
    }
    if (Number(amountFen) !== order.amountFen) {
      throw Object.assign(new Error(`金额不符：订单 ${order.amountFen} 分，支付 ${amountFen} 分。`), { status: 409, code: 'AMOUNT_MISMATCH' });
    }
    if (order.status === 'refunded') return { order, already: true, refunded: true };
    const already = ledger.hasOrderPurchase(order.outTradeNo);
    if (!already) {
      ledger.grant({
        accountId: order.accountId,
        credits: order.credits,
        expiresAt: order.creditValidDays > 0 ? now() + order.creditValidDays * 86_400_000 : null,
        orderId: order.outTradeNo,
        type: 'purchase',
        reason: `购买「${order.productTitle}」`,
      });
    }
    if (order.status !== 'paid') {
      order.status = 'paid';
      order.paidAt = paidAt || now();
      order.providerTradeNo = tradeNo;
      order.provider = provider;
      order.note = null;
    }
    save();
    return { order, already };
  }

  function close(order, reason) {
    if (!order) throw Object.assign(new Error('订单不存在。'), { status: 404 });
    if (order.status !== 'pending') return { order, changed: false };
    order.status = 'closed';
    order.note = reason || '未支付关闭';
    save();
    return { order, changed: true };
  }

  /**
   * 退款不是「把钱退回去」这一件事的全部：
   * 钱由支付渠道退，额度由这里扣。
   * 只收回这个订单还没用掉的额度；已经消耗掉的部分不追扣，
   * 记在 shortfall 里交给人工决定怎么处理。
   */
  function refund(order, { reason, actor }) {
    if (!order) throw Object.assign(new Error('订单不存在。'), { status: 404 });
    // 重复退款直接返回上一次的结果，不报错：运营连点两次不应该看到失败。
    if (order.refund) return { order, already: true, refund: order.refund };
    if (order.status !== 'paid') throw Object.assign(new Error('只有已支付的订单能退款。'), { status: 409 });
    if (!reason) throw Object.assign(new Error('退款必须写明原因。'), { status: 400 });
    const result = ledger.refundOrder({
      accountId: order.accountId,
      orderId: order.outTradeNo,
      credits: order.credits,
      reason: `退款：${reason}`,
      actor,
    });
    order.refund = { at: now(), actor, reason, removed: result.removed, shortfall: result.shortfall };
    order.status = 'refunded';
    save();
    return { order, already: false, refund: order.refund };
  }

  function markRefunded(order, refund) {
    order.status = 'refunded';
    order.refund = refund;
    save();
  }

  load();

  return { create, get, list, listAll, markPaid, close, refund, markRefunded, file, statuses: STATUSES };
}

module.exports = { createOrders };
