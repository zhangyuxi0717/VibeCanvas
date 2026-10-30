'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

/* ----------------------------------------
 * 支付宝电脑网站支付（alipay.trade.page.pay）
 *
 * 只用到三件事：
 *   1. 用应用私钥给下单参数签名，生成跳转地址；
 *   2. 用支付宝公钥验证异步通知（notify_url）；
 *   3. 主动查单（alipay.trade.query），响应节点同样要验签。
 *
 * 密钥只在服务端：私钥不出进程，公钥用来验签。
 * 这里不碰退款接口——退款的钱在支付宝商家后台操作，
 * 服务端只负责把该订单还没用掉的额度收回。
 *
 * 文档：
 *   电脑网站支付 https://opendocs.alipay.com/open/270/105898
 *   异步通知   https://opendocs.alipay.com/open/270/105902
 *   交易查询   https://opendocs.alipay.com/open/02ekfk
 *   验签规则   https://opendocs.alipay.com/common/02mse3
 * ---------------------------------------- */

const PAID_STATES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

function signContent(params) {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => params[key] !== null && params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function signRSA2(content, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  return signer.sign(privateKey, 'base64');
}

function verifyRSA2(content, signature, publicKey) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    return verifier.verify(publicKey, String(signature || ''), 'base64');
  } catch {
    return false;
  }
}

// 支付宝要求 timestamp 用北京时间，格式 yyyy-MM-dd HH:mm:ss
function shanghaiTime(ms) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// 网关响应里 sign 覆盖的是响应节点原文，不是重新序列化后的 JSON，所以必须从原文里截。
function extractNode(text, name) {
  const key = `"${name}"`;
  const at = text.indexOf(key);
  if (at < 0) return null;
  let i = text.indexOf(':', at + key.length);
  if (i < 0) return null;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function yuanToFen(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function readKey(value) {
  if (!value) return '';
  const text = String(value);
  if (text.includes('-----BEGIN')) return text.replace(/\\n/g, '\n');
  return fs.readFileSync(text, 'utf8').replace(/\r\n/g, '\n');
}

function createAlipayProvider({
  appId,
  privateKey,
  publicKey,
  gateway,
  notifyUrl,
  returnUrl,
  sellerId = '',
  timeoutMs = 15000,
  fetchImpl = fetch,
  allowInsecure = false,
  now = () => Date.now(),
} = {}) {
  const privatePem = readKey(privateKey);
  const publicPem = readKey(publicKey);
  if (!appId) throw new Error('缺少 ALIPAY_APP_ID');
  if (!privatePem) throw new Error('缺少应用私钥');
  if (!publicPem) throw new Error('缺少支付宝公钥');
  if (!gateway) throw new Error('缺少网关地址');

  const gatewayUrl = new URL(gateway);
  const secure = gatewayUrl.protocol === 'https:'
    || (allowInsecure && (gatewayUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(gatewayUrl.hostname)));
  if (!secure) throw new Error('支付网关必须是 https 地址');

  function signedParams(method, bizContent, extra = {}) {
    const params = {
      app_id: appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: shanghaiTime(now()),
      version: '1.0',
      ...extra,
      biz_content: JSON.stringify(bizContent),
    };
    params.sign = signRSA2(signContent(params), privatePem);
    return params;
  }

  function createPayment(order, urls = {}) {
    const notify = urls.notifyUrl || notifyUrl;
    const back = urls.returnUrl || returnUrl;
    if (!notify) throw new Error('缺少异步通知地址 notify_url');
    // 金额一律由订单决定，不接受调用方传入。
    const biz = {
      out_trade_no: order.outTradeNo,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: (order.amountFen / 100).toFixed(2),
      subject: order.productTitle,
      timeout_express: `${Math.max(1, Math.ceil((order.expiresAt - now()) / 60000))}m`,
    };
    const extra = { notify_url: notify };
    if (back) extra.return_url = back;
    const params = signedParams('alipay.trade.page.pay', biz, extra);
    const query = new URLSearchParams(params).toString();
    return { payUrl: `${gateway}?${query}` };
  }

  function verifyNotify(params) {
    const signature = params.sign;
    if (!signature) return { ok: false, reason: '缺少签名' };
    if (params.sign_type && params.sign_type !== 'RSA2') return { ok: false, reason: '签名类型不是 RSA2' };
    if (!verifyRSA2(signContent(params), signature, publicPem)) return { ok: false, reason: '签名不匹配' };
    if (params.app_id !== appId) return { ok: false, reason: 'app_id 不是本应用' };
    if (sellerId && params.seller_id && params.seller_id !== sellerId) return { ok: false, reason: 'seller_id 不匹配' };
    const amountFen = yuanToFen(params.total_amount);
    if (amountFen === null) return { ok: false, reason: '金额无法解析' };
    if (!PAID_STATES.has(params.trade_status)) {
      return { ok: false, reason: `交易状态不是成功：${params.trade_status || '未知'}`, notPaid: true };
    }
    if (!params.out_trade_no) return { ok: false, reason: '缺少商户订单号' };
    const paidAt = params.gmt_payment ? Date.parse(params.gmt_payment.replace(' ', 'T') + '+08:00') : null;
    return {
      ok: true,
      orderNo: params.out_trade_no,
      amountFen,
      currency: 'CNY',
      tradeNo: params.trade_no || null,
      paidAt: Number.isFinite(paidAt) ? paidAt : null,
      tradeStatus: params.trade_status,
    };
  }

  async function callGateway(method, bizContent) {
    const params = signedParams(method, bizContent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(params).toString(),
        redirect: 'error',
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) throw Object.assign(new Error('支付网关返回错误。'), { code: 'PROVIDER_HTTP' });
      const nodeName = method.replace(/\./g, '_') + '_response';
      const rawNode = extractNode(raw, nodeName);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('支付网关响应不是 JSON。'), { code: 'PROVIDER_BAD_JSON' }); }
      if (!rawNode) throw Object.assign(new Error('支付网关响应缺少业务节点。'), { code: 'PROVIDER_BAD_NODE' });
      if (parsed.sign && !verifyRSA2(rawNode, parsed.sign, publicPem)) {
        throw Object.assign(new Error('支付网关响应验签失败。'), { code: 'PROVIDER_SIGNATURE_INVALID' });
      }
      if (!parsed.sign) {
        throw Object.assign(new Error('支付网关响应没有签名，不能采信。'), { code: 'PROVIDER_SIGNATURE_MISSING' });
      }
      return JSON.parse(rawNode);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 主动查单。和异步通知一样，只信验签通过的结果。
   * 返回 {status:'paid'|'pending', amountFen, tradeNo}。
   */
  async function query(order) {
    let result;
    try {
      result = await callGateway('alipay.trade.query', { out_trade_no: order.outTradeNo });
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(new Error('查单超时。'), { code: 'PROVIDER_TIMEOUT' });
      throw err;
    }
    if (result.code !== '10000') {
      if (result.sub_code === 'ACQ.TRADE_NOT_EXIST') return { status: 'pending' };
      throw Object.assign(new Error(result.sub_msg || result.msg || '查单失败。'), { code: 'PROVIDER_QUERY_FAILED' });
    }
    if (result.out_trade_no && result.out_trade_no !== order.outTradeNo) {
      throw Object.assign(new Error('查单返回的订单号不一致。'), { code: 'PROVIDER_ORDER_MISMATCH' });
    }
    const amountFen = yuanToFen(result.total_amount);
    if (PAID_STATES.has(result.trade_status)) {
      if (amountFen !== order.amountFen) {
        throw Object.assign(new Error(`查单金额不符：订单 ${order.amountFen} 分，支付宝 ${amountFen} 分。`), { code: 'AMOUNT_MISMATCH' });
      }
      return { status: 'paid', amountFen, tradeNo: result.trade_no || null, currency: 'CNY' };
    }
    return { status: 'pending', amountFen: amountFen === null ? null : amountFen, tradeStatus: result.trade_status };
  }

  return { name: 'alipay', createPayment, verifyNotify, query, signContent, verifyRSA2, appId };
}

module.exports = { createAlipayProvider, signContent, signRSA2, verifyRSA2, extractNode, yuanToFen, shanghaiTime, PAID_STATES };
