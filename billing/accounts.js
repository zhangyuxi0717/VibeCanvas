'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ----------------------------------------
 * 匿名账户与签名令牌
 *
 * 这个版本没有登录体系，但「谁付的钱」必须由服务端认定，
 * 不能让浏览器自己报一个 id 就来领额度。
 *
 * 做法：账户 id 由服务端生成；令牌是服务端用密钥签过的
 * 「账户 id + 签发时间」，浏览器改一个字都对不上签名。
 * 令牌等价于一张不记名的余额卡：谁拿到都能用，
 * 所以要像密码一样对待它，不要发到聊天群里。
 * ---------------------------------------- */

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createAccounts({ dir, secret, now = () => Date.now(), logger = console } = {}) {
  if (!secret || String(secret).length < 32) throw new Error('账户密钥至少 32 个字符');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'accounts.json');
  const state = { version: 1, accounts: {} };

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.accounts && typeof data.accounts === 'object') state.accounts = data.accounts;
    } catch (err) {
      logger.warn({ event: 'accounts_load_failed', error: err.message });
    }
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function sign(accountId, issuedAt = now()) {
    const payload = base64url(JSON.stringify({ v: 1, id: accountId, iat: issuedAt }));
    const signature = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
    return `${payload}.${signature}`;
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length > 512) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    const expected = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
    if (!safeEqual(signature, expected)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
    if (!data || data.v !== 1 || typeof data.id !== 'string') return null;
    return state.accounts[data.id] ? data.id : null;
  }

  function create({ ip = null } = {}) {
    const id = crypto.randomUUID();
    const record = { id, createdAt: now(), firstIp: ip ? String(ip).slice(0, 64) : null };
    state.accounts[id] = record;
    save();
    return { account: record, token: sign(id), created: true };
  }

  function get(id) {
    return state.accounts[id] || null;
  }

  function ensure({ token, ip } = {}) {
    const id = token ? verify(token) : null;
    if (id) return { account: state.accounts[id], token, created: false };
    return create({ ip });
  }

  load();

  return { create, get, verify, sign, ensure, count: () => Object.keys(state.accounts).length, file };
}

module.exports = { createAccounts, safeEqual, base64url };
