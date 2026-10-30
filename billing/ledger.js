'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ----------------------------------------
 * 不可变额度流水
 *
 * 每一笔额度变动都是一行 JSON，只追加、不修改、不删除。
 * 账户余额不是存出来的字段，而是把流水从头算一遍得到的，
 * 所以任何一次重启、任何一次并发，看到的都是同一串流水算出的同一个数。
 *
 * 术语：
 *   lot          一次「发放」形成的额度批次，带有效期
 *   reserve      预占：从批次里扣出可用额度，转到「已预占」
 *   consume      消耗：预占转成真正花掉
 *   release      释放：预占退回原批次
 *   expire       过期：批次剩余额度归零
 *   adjust       运营调整，可正可负
 *   refund       退款：从某个订单产生的批次里收回剩余额度
 *
 * 所有公开方法都是同步的。Node 单线程 + 同步追加写，
 * 保证「读余额 → 写流水」之间不会被别的请求打断，不会并发超扣。
 * ---------------------------------------- */

const TYPES = new Set(['grant', 'purchase', 'reserve', 'consume', 'release', 'expire', 'adjust', 'refund']);

function createLedger({ dir, now = () => Date.now(), logger = console } = {}) {
  if (!dir) throw new Error('ledger 需要 dir');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger.jsonl');

  const entries = [];
  const lots = new Map();          // lotId -> lot
  const accountLots = new Map();   // accountId -> Set<lotId>
  const reservations = new Map();  // taskId -> { accountId, parts: Map<lotId, credits>, at, reason }
  let seq = 0;
  let damagedLines = 0;

  function apply(entry) {
    switch (entry.type) {
      case 'grant':
      case 'purchase': {
        const lot = {
          lotId: entry.lotId,
          accountId: entry.accountId,
          credits: entry.credits,
          remaining: entry.credits,
          expiresAt: entry.expiresAt ?? null,
          at: entry.at,
          reason: entry.reason || null,
          orderId: entry.orderId || null,
        };
        lots.set(lot.lotId, lot);
        if (!accountLots.has(lot.accountId)) accountLots.set(lot.accountId, new Set());
        accountLots.get(lot.accountId).add(lot.lotId);
        return;
      }
      case 'adjust': {
        if (entry.credits > 0) {
          const lot = {
            lotId: entry.lotId,
            accountId: entry.accountId,
            credits: entry.credits,
            remaining: entry.credits,
            expiresAt: entry.expiresAt ?? null,
            at: entry.at,
            reason: entry.reason || null,
            orderId: null,
          };
          lots.set(lot.lotId, lot);
          if (!accountLots.has(lot.accountId)) accountLots.set(lot.accountId, new Set());
          accountLots.get(lot.accountId).add(lot.lotId);
        } else {
          const lot = lots.get(entry.lotId);
          if (lot) lot.remaining = Math.max(0, lot.remaining - Math.abs(entry.credits));
        }
        return;
      }
      case 'expire':
      case 'refund': {
        const lot = lots.get(entry.lotId);
        if (lot) lot.remaining = Math.max(0, lot.remaining - Math.abs(entry.credits));
        return;
      }
      case 'reserve': {
        const lot = lots.get(entry.lotId);
        if (!lot) return;
        lot.remaining = Math.max(0, lot.remaining - entry.credits);
        const reservation = reservations.get(entry.taskId) || {
          accountId: entry.accountId,
          parts: new Map(),
          at: entry.at,
          reason: entry.reason || null,
        };
        reservation.parts.set(entry.lotId, (reservation.parts.get(entry.lotId) || 0) + entry.credits);
        reservations.set(entry.taskId, reservation);
        return;
      }
      case 'release': {
        const reservation = reservations.get(entry.taskId);
        if (!reservation) return;
        const held = reservation.parts.get(entry.lotId) || 0;
        if (held < entry.credits) return;
        const lot = lots.get(entry.lotId);
        if (lot) lot.remaining += entry.credits;
        const left = held - entry.credits;
        if (left > 0) reservation.parts.set(entry.lotId, left);
        else reservation.parts.delete(entry.lotId);
        if (!reservation.parts.size) reservations.delete(entry.taskId);
        return;
      }
      case 'consume': {
        reservations.delete(entry.taskId);
        return;
      }
      default:
        return;
    }
  }

  function load() {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { damagedLines++; continue; }
      if (!entry || !TYPES.has(entry.type) || typeof entry.accountId !== 'string') { damagedLines++; continue; }
      entries.push(entry);
      seq = Math.max(seq, Number(entry.seq) || 0);
      apply(entry);
    }
    if (damagedLines) logger.warn({ event: 'ledger_damaged_lines', file, count: damagedLines });
  }

  function write(entry) {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    entries.push(entry);
    apply(entry);
  }

  function append(type, fields) {
    if (!TYPES.has(type)) throw new Error('未知流水类型：' + type);
    const entry = { v: 1, seq: seq + 1, id: crypto.randomUUID(), at: now(), type, ...fields };
    write(entry);
    return entry;
  }

  function lotsOf(accountId) {
    return [...(accountLots.get(accountId) || [])].map((id) => lots.get(id)).filter(Boolean);
  }

  function availableOf(accountId) {
    return lotsOf(accountId).reduce((sum, lot) => sum + lot.remaining, 0);
  }

  function reservedOf(accountId) {
    let total = 0;
    for (const reservation of reservations.values()) if (reservation.accountId === accountId) total += partsTotal(reservation);
    return total;
  }

  function partsTotal(reservation) {
    let total = 0;
    for (const credits of reservation.parts.values()) total += credits;
    return total;
  }

  // 过期批次在每次余额变动前清一次，过期本身也留下流水。
  function sweepExpired(accountId = null) {
    const current = now();
    for (const lot of lots.values()) {
      if (lot.remaining <= 0) continue;
      if (!lot.expiresAt || lot.expiresAt > current) continue;
      if (accountId && lot.accountId !== accountId) continue;
      append('expire', { accountId: lot.accountId, lotId: lot.lotId, credits: lot.remaining, reason: '批次到期' });
    }
  }

  // 消耗时优先用最早到期的批次
  function pickLots(accountId, predicate = () => true) {
    return lotsOf(accountId)
      .filter((lot) => lot.remaining > 0 && predicate(lot))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.at - b.at);
  }

  function updateAccountLots(accountId, lotId) {
    if (!accountLots.has(accountId)) accountLots.set(accountId, new Set());
    accountLots.get(accountId).add(lotId);
  }

  function grant({ accountId, credits, expiresAt = null, reason = '', orderId = null, type = 'grant', actor = null, lotId = null }) {
    if (!accountId) throw new Error('缺少账户');
    if (!Number.isInteger(credits) || credits <= 0) throw new Error('发放额度必须是正整数');
    const id = lotId || crypto.randomUUID();
    if (lots.has(id)) return { lotId: id, credits, expiresAt, already: true };
    const entry = append(type, { accountId, lotId: id, credits, expiresAt, reason, orderId, actor });
    updateAccountLots(accountId, id);
    return { lotId: entry.lotId, credits, expiresAt, already: false };
  }

  function reserve({ accountId, taskId, credits, reason = '生成预占' }) {
    if (!accountId) throw new Error('缺少账户');
    if (typeof taskId !== 'string' || !taskId) throw new Error('缺少任务标识');
    if (!Number.isInteger(credits) || credits <= 0) throw new Error('预占额度必须是正整数');
    if (reservations.has(taskId)) return { taskId, credits: partsTotal(reservations.get(taskId)), already: true };
    sweepExpired(accountId);
    const available = availableOf(accountId);
    if (available < credits) {
      throw Object.assign(new Error(`可用额度不足：需要 ${credits}，当前 ${available}。`), { status: 402, code: 'INSUFFICIENT_CREDITS', available });
    }
    let need = credits;
    for (const lot of pickLots(accountId)) {
      if (!need) break;
      const take = Math.min(lot.remaining, need);
      append('reserve', { accountId, taskId, lotId: lot.lotId, credits: take, reason });
      need -= take;
    }
    return { taskId, credits, already: false };
  }

  function release({ taskId, reason = '释放预占' }) {
    const reservation = reservations.get(taskId);
    if (!reservation) return { taskId, released: 0, already: true };
    let released = 0;
    for (const [lotId, credits] of [...reservation.parts.entries()]) {
      append('release', { accountId: reservation.accountId, taskId, lotId, credits, reason });
      released += credits;
    }
    return { taskId, released, already: false };
  }

  function consume({ taskId, reason = '生成成功' }) {
    const reservation = reservations.get(taskId);
    if (!reservation) return { taskId, consumed: 0, already: true };
    const credits = partsTotal(reservation);
    const entry = append('consume', { accountId: reservation.accountId, taskId, credits, reason });
    return { taskId, consumed: credits, already: false, entryId: entry.id };
  }

  function adjust({ accountId, credits, reason, actor = 'admin', expiresAt = null }) {
    if (!accountId) throw new Error('缺少账户');
    if (!Number.isInteger(credits) || credits === 0) throw new Error('调整额度必须是非零整数');
    if (!reason) throw new Error('调整必须写明原因');
    sweepExpired(accountId);
    if (credits > 0) {
      const lotId = crypto.randomUUID();
      append('adjust', { accountId, lotId, credits, reason, actor, expiresAt });
      updateAccountLots(accountId, lotId);
      return { applied: credits };
    }
    let need = -credits;
    let applied = 0;
    for (const lot of pickLots(accountId)) {
      if (!need) break;
      const take = Math.min(lot.remaining, need);
      append('adjust', { accountId, lotId: lot.lotId, credits: -take, reason, actor });
      applied += take;
      need -= take;
    }
    return { applied: -applied, shortfall: need };
  }

  function refundOrder({ accountId, orderId, credits, reason, actor = 'admin' }) {
    let need = credits;
    let removed = 0;
    for (const lot of lotsOf(accountId).filter((item) => item.orderId === orderId && item.remaining > 0)) {
      if (!need) break;
      const take = Math.min(lot.remaining, need);
      append('refund', { accountId, orderId, lotId: lot.lotId, credits: take, reason, actor });
      removed += take;
      need -= take;
    }
    return { removed, shortfall: need };
  }

  function balance(accountId) {
    sweepExpired(accountId);
    const list = lotsOf(accountId)
      .filter((lot) => lot.remaining > 0 || lot.credits > 0)
      .sort((a, b) => a.at - b.at)
      .map((lot) => ({
        lotId: lot.lotId, credits: lot.credits, remaining: lot.remaining,
        expiresAt: lot.expiresAt, at: lot.at, reason: lot.reason, orderId: lot.orderId,
      }));
    return { available: availableOf(accountId), reserved: reservedOf(accountId), lots: list };
  }

  function usage(accountId, limit = 50) {
    const list = [];
    for (let i = entries.length - 1; i >= 0 && list.length < limit; i--) {
      const entry = entries[i];
      if (entry.accountId !== accountId) continue;
      if (!['grant', 'purchase', 'reserve', 'consume', 'release', 'expire', 'adjust', 'refund'].includes(entry.type)) continue;
      list.push({
        id: entry.id, at: entry.at, type: entry.type,
        credits: entry.credits ?? null, taskId: entry.taskId || null, orderId: entry.orderId || null,
        reason: entry.reason || null,
      });
    }
    return list;
  }

  function entriesForOrder(orderId) {
    return entries.filter((entry) => entry.orderId === orderId);
  }

  function hasOrderPurchase(orderId) {
    return entries.some((entry) => entry.type === 'purchase' && entry.orderId === orderId);
  }

  function hasLot(lotId) {
    return lots.has(lotId);
  }

  function openReservations() {
    return [...reservations.entries()].map(([taskId, reservation]) => ({
      taskId, accountId: reservation.accountId, credits: partsTotal(reservation), at: reservation.at, reason: reservation.reason,
    }));
  }

  function stats() {
    return { entries: entries.length, lots: lots.size, reservations: reservations.size, damagedLines, file };
  }

  load();

  return {
    file,
    grant, reserve, release, consume, adjust, refundOrder,
    balance, usage, entriesForOrder, hasOrderPurchase, hasLot, openReservations, stats,
    // 内部用：仅供测试与运营看原始流水
    _all: () => entries,
  };
}

module.exports = { createLedger };
