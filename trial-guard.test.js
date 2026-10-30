'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, loadConfig } = require('./server');
const { createTelemetry } = require('./telemetry');

const valid = {
  title: '校园读书会', subtitle: '把喜欢的书带来分享', description: '周六下午在图书馆三层，带上最近在读的一本书。',
  tags: ['读书'], event: { time: '周六下午', location: null, organizer: null },
  publishCopy: { title: '校园读书会', body: '带上最近在读的一本书来图书馆三层。', tags: ['读书'] },
};

function fakeCloud(user) {
  return {
    configured: true,
    client: {
      authUser: async () => {
        if (typeof user === 'function') return user();
        if (user instanceof Error) throw user;
        return user;
      },
      dbRequest: async () => [],
    },
    list: async () => [], get: async () => [], insert: async () => [], update: async () => [], remove: async () => [],
    uploadAsset: async () => ({}), removeAsset: async () => {}, signedAssetUrl: async () => 'https://signed.invalid/x',
  };
}

async function withApp(options, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-guard-'));
  const { env = {}, ...appOptions } = options;
  const config = loadConfig({ DATA_DIR: dataDir, STATIC_ROOT: path.join(process.cwd(), 'public'), TRIAL_ALLOWED_EMAILS: 'insider@example.com', ...env });
  const telemetry = createTelemetry({ dataDir, enabled: true });
  const app = createApp({
    apiKey: 'test-key', apiUrl: 'https://model.invalid', model: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(valid) } }] }) }),
    ...appOptions,
  }, config, telemetry);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { return await fn(base, { dataDir, config }); }
  finally { await new Promise((resolve) => app.close(resolve)); }
}

test('健康检查不泄露内部信息，就绪检查说明各组件状态', async () => {
  await withApp({ cloudStore: fakeCloud({ id: 'u1', email: 'insider@example.com' }) }, async (base) => {
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.deepEqual(Object.keys(healthBody).sort(), ['status', 'uptime']);

    const ready = await fetch(base + '/readyz');
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.checks.static.ok, true);
    assert.equal(readyBody.checks.dataDir.ok, true);
    assert.equal(readyBody.checks.database.ok, true);
  });
});

test('云端未配置时就绪检查标为 disabled，不把本地作品库判死', async () => {
  const app = createApp({ apiKey: 'k', apiUrl: 'https://x.invalid', model: 'm' }, loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-guard-')), STATIC_ROOT: 'public' }), createTelemetry({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-guard-')), enabled: false }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/readyz`)).json();
    assert.equal(body.status, 'ready');
    assert.deepEqual(body.checks.database, { ok: true, detail: 'disabled' });
  } finally { await new Promise((resolve) => app.close(resolve)); }
});

test('试用名单外的账号被拒绝，名单内的账号放行', async () => {
  await withApp({ cloudStore: fakeCloud({ id: 'u2', email: 'outsider@example.com' }) }, async (base) => {
    const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' }, body: JSON.stringify({ prompt: '读书会' }) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /受邀账号/);
  });
  await withApp({ cloudStore: fakeCloud({ id: 'u1', email: 'Insider@Example.com' }) }, async (base) => {
    const r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' }, body: JSON.stringify({ prompt: '读书会' }) });
    assert.equal(r.status, 200);
  });
});

test('登录过期返回 401 和可操作的提示，不暴露令牌细节', async () => {
  await withApp({ cloudStore: fakeCloud(new Error('jwt expired')) }, async (base) => {
    const r = await fetch(base + '/api/cloud/works', { headers: { authorization: 'Bearer expired-token' } });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.match(body.error, /登录已失效，请重新登录/);
    assert.ok(!JSON.stringify(body).includes('jwt'));
  });
});

test('额度用完返回 429，并说清楚是今日额度的哪一种', async () => {
  await withApp({ env: { GENERATE_DAILY_LIMIT: '2', GENERATE_PER_USER_DAILY_LIMIT: '1' } }, async (base) => {
    const post = () => fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '读书会' }) });
    assert.equal((await post()).status, 200);
    const second = await post();
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /今日生成额度已用完/);
  });
});

test('全局额度用完时提示的是服务总额度，不是个人额度', async () => {
  await withApp({ env: { GENERATE_DAILY_LIMIT: '1', GENERATE_PER_USER_DAILY_LIMIT: '5' } }, async (base) => {
    const post = () => fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '读书会' }) });
    assert.equal((await post()).status, 200);
    const second = await post();
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /总额度/);
  });
});

test('每个响应都带安全头，错误响应也不带堆栈', async () => {
  await withApp({}, async (base) => {
    const r = await fetch(base + '/api/nope');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const text = await r.text();
    assert.ok(!/at .*\.js:\d+/.test(text));
  });
});

test('静态资源只放行白名单，仓库文件读不到', async () => {
  await withApp({}, async (base) => {
    for (const p of ['/package.json', '/.env', '/server.js', '/config.js']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
    assert.equal((await fetch(base + '/work-library.js')).status, 200);
  });
});

test('事件接口只落白名单事件和白名单属性，反馈不记 IP', async () => {
  await withApp({}, async (base, { dataDir }) => {
    const r = await fetch(base + '/api/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anonymousId: 'anon-12345678', appVersion: 'test',
        events: [
          { name: 'generate_start', props: { mode: 'ai', prompt: '用户正文不该落盘', email: 'a@b.com' } },
          { name: 'not_allowed', props: {} },
          { name: 'export', props: { target: 'zip', pageCount: 3 } },
        ],
      }),
    });
    assert.equal(r.status, 202);
    const file = path.join(dataDir, 'events', `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((item) => item.name), ['generate_start', 'export']);
    assert.deepEqual(lines[0].props, { mode: 'ai' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('用户正文'));

    const fb = await fetch(base + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 5, message: '好用' }) });
    assert.equal(fb.status, 201);
    const fbFile = path.join(dataDir, 'feedback', `feedback-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const record = JSON.parse(fs.readFileSync(fbFile, 'utf8').trim());
    assert.equal(record.rating, 5);
    assert.equal(record.message, '好用');
    assert.equal(record.source.length, 12);
    assert.ok(!('ip' in record));
  });
});

test('未知路径和超长请求体都被拒，且响应是 JSON', async () => {
  await withApp({}, async (base) => {
    const big = await fetch(base + '/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [], pad: 'x'.repeat(20000) }) });
    assert.equal(big.status, 413);
    assert.match(big.headers.get('content-type') || '', /application\/json/);
  });
});

test('非法来源的跨站请求被拒绝', async () => {
  await withApp({}, async (base) => {
    const r = await fetch(base + '/api/events', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: JSON.stringify({ events: [{ name: 'edit' }] }) });
    assert.equal(r.status, 403);
  });
});
