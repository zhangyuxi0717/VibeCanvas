'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* ----------------------------------------
 * 运营审计日志
 *
 * 谁、在什么时候、对哪个账户或订单、做了什么、写了什么原因。
 * 只追加，不修改。运营操作必须带原因，日志里原样保留。
 * ---------------------------------------- */

function createAudit({ dir, now = () => Date.now(), logger = console } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'audit.jsonl');

  function record({ actor = 'system', action, target = null, detail = null, ip = null }) {
    if (!action) throw new Error('审计记录缺少 action');
    const entry = {
      at: now(),
      actor: String(actor).slice(0, 120),
      action: String(action).slice(0, 60),
      target: target == null ? null : String(target).slice(0, 120),
      detail: detail == null ? null : detail,
      ip: ip == null ? null : String(ip).slice(0, 64),
    };
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      // 审计写不进去不能悄悄吞掉，但也不能因此中断已经发生的资金操作，所以只报错。
      logger.error({ event: 'audit_write_failed', error: err.message, action: entry.action });
    }
    return entry;
  }

  function list(limit = 100) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const entries = [];
    // 从后往前取，遇到写坏的半行跳过，不影响其余记录。
    for (let i = lines.length - 1; i >= 0 && entries.length < Math.min(Math.max(limit, 1), 1000); i--) {
      try { entries.push(JSON.parse(lines[i])); } catch { /* 跳过损坏行 */ }
    }
    return entries;
  }

  return { record, list, file };
}

module.exports = { createAudit };
