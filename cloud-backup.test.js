'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSupabaseClient } = require('./cloud-store');
const { exportWorks, buildBackup, parseBackup, importWorks, verifyWorks } = require('./cloud-backup');

/* 一个最小 PostgREST：支持 GET 列表（limit/offset/id 过滤）和 POST upsert。
 * 用它真跑一遍「导出 → 删库 → 恢复 → 校验」，证明脚本逻辑可用，代替连真实数据库。 */
function fakePostgrest(initial) {
  let rows = initial.map((row) => ({ ...row }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/rest/v1/cloud_works') {
      let list = rows.slice();
      const idFilter = url.searchParams.get('id');
      if (idFilter && idFilter.startsWith('in.')) {
        const ids = new Set(idFilter.slice(3).replace(/[()"]/g, '').split(',').filter(Boolean));
        list = list.filter((row) => ids.has(row.id));
      }
      const limit = Number(url.searchParams.get('limit') || 0);
      const offset = Number(url.searchParams.get('offset') || 0);
      if (offset) list = list.slice(offset);
      if (limit) list = list.slice(0, limit);
      return send(200, list);
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/cloud_works') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const incoming = JSON.parse(body);
      if (!Array.isArray(incoming)) return send(400, { message: 'expected array' });
      for (const row of incoming) {
        const index = rows.findIndex((item) => item.id === row.id);
        if (index >= 0) rows[index] = { ...rows[index], ...row };
        else rows.push({ ...row });
      }
      return send(201, []);
    }
    return send(404, { message: 'not found' });
  });
  return { server, rows: () => rows.slice(), clear: () => { rows = []; } };
}

async function withServer(initial, fn) {
  const fake = fakePostgrest(initial);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const { port } = fake.server.address();
  const client = createSupabaseClient({ url: `http://127.0.0.1:${port}`, anonKey: 'anon', serviceKey: 'service' });
  try { return await fn({ fake, client }); }
  finally { await new Promise((resolve) => fake.server.close(resolve)); }
}

const sample = [
  { id: 'w1', user_id: 'u1', source_local_id: 'l1', name: '作品一', document_type: 'single', document_json: { title: '一' }, revision: 3, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' },
  { id: 'w2', user_id: 'u2', source_local_id: 'l2', name: '作品二', document_type: 'carousel', document_json: { pages: [1, 2] }, revision: 1, created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-04T00:00:00Z' },
  { id: 'w3', user_id: 'u1', source_local_id: 'l3', name: '作品三', document_type: 'single', document_json: { title: '三' }, revision: 7, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' },
];

test('导出会按页取全，不只拿第一页', async () => {
  await withServer(sample, async ({ client }) => {
    const rows = await exportWorks(client, { pageSize: 2 });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.id).sort(), ['w1', 'w2', 'w3']);
  });
});

test('备份文件能原样解析，坏文件会被拒', async () => {
  await withServer(sample, async ({ client }) => {
    const rows = await exportWorks(client);
    const backup = buildBackup(rows, { now: new Date('2026-10-30T12:00:00Z') });
    const text = JSON.stringify(backup);
    const parsed = parseBackup(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.skipped, 0);
    assert.equal(parsed.createdAt, '2026-10-30T12:00:00.000Z');

    assert.equal(parseBackup('not json').ok, false);
    assert.equal(parseBackup(JSON.stringify({ format: 'other' })).ok, false);
    assert.equal(parseBackup(JSON.stringify({ format: 'vibecanvas-cloud_works', rows: 'x' })).ok, false);
  });
});

test('导出 → 清空 → 恢复，行数和版本都回来了', async () => {
  await withServer(sample, async ({ fake, client }) => {
    const backupText = JSON.stringify(buildBackup(await exportWorks(client)));
    fake.clear();
    assert.equal(fake.rows().length, 0);

    const parsed = parseBackup(backupText);
    const result = await importWorks(client, parsed.rows, { batchSize: 2 });
    assert.equal(result.imported, 3);

    const after = fake.rows();
    assert.equal(after.length, 3);
    assert.equal(after.find((row) => row.id === 'w3').revision, 7);
    assert.deepEqual(after.find((row) => row.id === 'w2').document_json, { pages: [1, 2] });

    const check = await verifyWorks(client, ['w1', 'w2', 'w3']);
    assert.equal(check.found, 3);
    assert.deepEqual(check.missing, []);
  });
});

test('恢复可以重复执行，不会产生重复行', async () => {
  await withServer(sample, async ({ fake, client }) => {
    const parsed = parseBackup(JSON.stringify(buildBackup(await exportWorks(client))));
    await importWorks(client, parsed.rows);
    await importWorks(client, parsed.rows);
    assert.equal(fake.rows().length, 3);
  });
});

test('演练模式不写云端', async () => {
  await withServer(sample, async ({ fake, client }) => {
    const parsed = parseBackup(JSON.stringify(buildBackup(await exportWorks(client))));
    fake.clear();
    const preview = await importWorks(client, parsed.rows, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.total, 3);
    assert.equal(fake.rows().length, 0);
  });
});

test('结构不完整的行会被跳过并计数，不会写进去', async () => {
  await withServer([], async ({ fake, client }) => {
    const rows = [
      { id: 'ok', user_id: 'u1', document_json: { a: 1 }, revision: 1 },
      { id: 'no-doc', user_id: 'u1' },
      { user_id: 'u1', document_json: {} },
      null,
    ];
    const result = await importWorks(client, rows);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 3);
    assert.deepEqual(fake.rows().map((row) => row.id), ['ok']);
  });
});

test('校验能发现缺失的行', async () => {
  await withServer(sample, async ({ fake, client }) => {
    fake.clear();
    const check = await verifyWorks(client, ['w1', 'gone']);
    assert.equal(check.found, 0);
    assert.deepEqual(check.missing, ['w1', 'gone']);
  });
});
