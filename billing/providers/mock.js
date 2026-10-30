'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { base64url, safeEqual } = require('../accounts');

/* ----------------------------------------
 * 模拟支付渠道（只用于开发和沙箱演练）
 *
 * 它走的路径和真实渠道一样：下单 → 跳转支付页 → 服务端收到「支付通知」→ 验签 → 发货。
 * 区别只是通知的签名用 HMAC 而不是支付宝的 RSA2，钱没真的动。
 * 生产环境不允许开启，配置检查会直接拒绝启动。
 * ---------------------------------------- */

function createMockProvider({ secret, dir, now = () => Date.now(), logger = console } = {}) {
  if (!secret || String(secret).length < 16) throw new Error('模拟支付渠道需要至少 16 个字符的签名密钥');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mock-trades.json');
  const state = { version: 1, trades: {} };
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.trades) state.trades = data.trades;
    } catch (err) {
      logger.warn({ event: 'mock_trades_load_failed', error: err.message });
    }
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function hmac(content) {
    return base64url(crypto.createHmac('sha256', secret).update(content).digest());
  }

  function signContent(params) {
    return Object.keys(params)
      .filter((key) => key !== 'sign' && key !== 'sign_type')
      .filter((key) => params[key] !== null && params[key] !== undefined && params[key] !== '')
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
  }

  function createPayment(order) {
    state.trades[order.outTradeNo] = {
      outTradeNo: order.outTradeNo,
      amountFen: order.amountFen,
      status: 'pending',
      tradeNo: null,
      createdAt: now(),
      paidAt: null,
    };
    save();
    const sig = hmac(`${order.outTradeNo}.${order.amountFen}`);
    return { payUrl: `/api/billing/mock/pay?out_trade_no=${encodeURIComponent(order.outTradeNo)}&sign=${encodeURIComponent(sig)}` };
  }

  function verifyLink(outTradeNo, sign) {
    const trade = state.trades[outTradeNo];
    if (!trade) return null;
    if (!safeEqual(String(sign || ''), hmac(`${outTradeNo}.${trade.amountFen}`))) return null;
    return trade;
  }

  function markPaid(outTradeNo) {
    const trade = state.trades[outTradeNo];
    if (!trade) throw Object.assign(new Error('模拟交易不存在。'), { status: 404 });
    if (trade.status !== 'paid') {
      trade.status = 'paid';
      trade.tradeNo = 'MOCK' + now() + crypto.randomBytes(2).toString('hex').toUpperCase();
      trade.paidAt = now();
      save();
    }
    return trade;
  }

  function markClosed(outTradeNo) {
    const trade = state.trades[outTradeNo];
    if (!trade) return null;
    if (trade.status === 'pending') { trade.status = 'closed'; save(); }
    return trade;
  }

  function buildNotify(outTradeNo, { tradeStatus = 'TRADE_SUCCESS' } = {}) {
    const trade = state.trades[outTradeNo];
    if (!trade) throw new Error('模拟交易不存在。');
    const params = {
      app_id: 'mock-app-001',
      out_trade_no: outTradeNo,
      total_amount: (trade.amountFen / 100).toFixed(2),
      trade_status: tradeStatus,
      trade_no: trade.tradeNo || '',
      sign_type: 'MOCK_HMAC',
    };
    params.sign = hmac(signContent(params));
    return params;
  }

  function verifyNotify(params) {
    if (!params || typeof params !== 'object') return { ok: false, reason: '通知为空' };
    if (params.sign_type !== 'MOCK_HMAC') return { ok: false, reason: '签名类型不符' };
    if (!params.sign || !safeEqual(String(params.sign), hmac(signContent(params)))) return { ok: false, reason: '签名不匹配' };
    if (params.app_id !== 'mock-app-001') return { ok: false, reason: 'app_id 不符' };
    const trade = state.trades[params.out_trade_no];
    if (!trade) return { ok: false, reason: '模拟交易不存在' };
    const amountFen = Math.round(Number(params.total_amount) * 100);
    if (!Number.isFinite(amountFen)) return { ok: false, reason: '金额无法解析' };
    if (params.trade_status !== 'TRADE_SUCCESS') {
      return { ok: false, reason: `交易状态不是成功：${params.trade_status || '未知'}`, notPaid: true };
    }
    return {
      ok: true,
      orderNo: params.out_trade_no,
      amountFen,
      currency: 'CNY',
      tradeNo: params.trade_no || trade.tradeNo || null,
      paidAt: trade.paidAt || null,
      tradeStatus: params.trade_status,
    };
  }

  function query(order) {
    const trade = state.trades[order.outTradeNo];
    if (!trade) return { status: 'pending' };
    if (trade.status === 'paid') return { status: 'paid', amountFen: trade.amountFen, tradeNo: trade.tradeNo, currency: 'CNY' };
    return { status: 'pending' };
  }

  return { name: 'mock', createPayment, verifyLink, markPaid, markClosed, buildNotify, verifyNotify, query, file };
}

module.exports = { createMockProvider };
