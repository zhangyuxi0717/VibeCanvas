'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ----------------------------------------
 * 轻量产品事件与反馈
 *
 * 只记「发生了什么」，不记用户写了什么：
 * 白名单事件名 + 白名单属性（短枚举/数字），正文、照片、邮箱、IP 一律不落盘。
 * 落盘为按天切分的 JSONL，方便 grep 和直接统计，不引入额外服务。
 * ---------------------------------------- */

const EVENTS = new Set([
  'generate_start', 'generate_success', 'generate_fail',
  'image_start', 'image_success', 'image_fail',
  'edit', 'export', 'save', 'open_work', 'feedback_open',
]);

const NUMERIC_PROPS = new Set(['durationMs', 'count', 'pageCount', 'imagesOk', 'imagesFailed']);
const ENUM_PROPS = {
  mode: ['text', 'upload', 'ai'],
  documentType: ['single', 'carousel'],
  styleId: ['minimal', 'visual', 'magazine'],
  paletteId: ['matcha', 'lavender', 'peach', 'sky'],
  errorKind: ['network', 'timeout', 'format', 'quota', 'auth', 'server', 'image', 'unknown'],
  target: ['page', 'zip', 'single'],
  surface: ['sidebar', 'dialog'],
};

function cleanProps(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (NUMERIC_PROPS.has(key)) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0 && number <= 86_400_000) out[key] = Math.round(number);
    } else if (ENUM_PROPS[key]) {
      if (ENUM_PROPS[key].includes(value)) out[key] = value;
    }
  }
  return out;
}

function dayFile(dir, prefix, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return path.join(dir, `${prefix}-${day}.jsonl`);
}

function createTelemetry({ dataDir, enabled = true, now = () => Date.now(), maxBytesPerDay = 50 * 1024 * 1024 } = {}) {
  const eventDir = path.join(dataDir, 'events');
  const feedbackDir = path.join(dataDir, 'feedback');
  const counters = new Map(); // 轻量的单进程限额，防止前端死循环刷文件

  const append = (dir, prefix, record) => {
    if (!enabled) return;
    fs.mkdirSync(dir, { recursive: true });
    const file = dayFile(dir, prefix, now());
    try {
      if (fs.statSync(file).size > maxBytesPerDay) return;
    } catch {}
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  };

  /** 一批事件。返回实际写入条数，调用方据此回 200。 */
  function recordEvents({ events, anonymousId, appVersion }, ip) {
    if (!Array.isArray(events) || !events.length) return 0;
    const list = events.slice(0, 20);
    const allowed = [];
    for (const item of list) {
      if (!item || typeof item.name !== 'string' || !EVENTS.has(item.name)) continue;
      allowed.push({ name: item.name, props: cleanProps(item.props) });
    }
    if (!allowed.length) return 0;
    // 每个来源每分钟最多 60 批，防止接口被当成写盘工具。
    const bucketKey = `${ip}:${new Date(now()).toISOString().slice(0, 16)}`;
    const used = counters.get(bucketKey) || 0;
    if (used >= 60) return 0;
    counters.set(bucketKey, used + 1);
    if (counters.size > 5000) counters.clear();

    const ts = new Date(now()).toISOString();
    const id = typeof anonymousId === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(anonymousId) ? anonymousId : null;
    for (const event of allowed) append(eventDir, 'events', { ts, id, version: String(appVersion || '').slice(0, 32), ...event });
    return allowed.length;
  }

  function recordFeedback({ rating, message }, ip) {
    const score = Number(rating);
    const safeRating = Number.isInteger(score) && score >= 1 && score <= 5 ? score : null;
    const text = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!safeRating && !text) throw Object.assign(new Error('反馈内容不能为空。'), { status: 400 });
    append(feedbackDir, 'feedback', {
      ts: new Date(now()).toISOString(),
      // 不存 IP：同一来源用短哈希做去重/防刷即可，无法反查到人
      source: crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 12),
      rating: safeRating,
      message: text,
    });
    return true;
  }

  return { recordEvents, recordFeedback, cleanProps, EVENTS };
}

module.exports = { createTelemetry, cleanProps, EVENTS };
