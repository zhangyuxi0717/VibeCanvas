'use strict';

/* ----------------------------------------
 * 云端作品库的逻辑备份与恢复
 *
 * 为什么不用 pg_dump：Supabase 的连接串和数据库密码不好长期保管，
 * 而云端作品只有一张 cloud_works 表，用 service key 走 REST 导出 JSON
 * 已经能覆盖「升级出错、误删、误覆盖」这几种情况。
 * 需要整库备份（含每张图片文件）时，仍以 Supabase 控制台的备份为准，见 docs/DEPLOY.md。
 *
 * 只处理数据库行；Storage 里的图片文件不在本模块范围内。
 * ---------------------------------------- */

const COLUMNS = ['id', 'user_id', 'source_local_id', 'name', 'document_type', 'document_json', 'revision', 'created_at', 'updated_at'];

function pickColumns(row) {
  const out = {};
  for (const key of COLUMNS) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

/** 分页导出整张 cloud_works。返回按 id 升序的行。 */
async function exportWorks(client, { pageSize = 200 } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.dbRequest(`/cloud_works?select=*&order=id.asc&limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error('导出失败：接口返回的不是数据列表。');
    rows.push(...page);
    if (page.length < pageSize) break;
    if (offset > 1_000_000) throw new Error('导出失败：数据量超过预期，已中止。');
  }
  return rows;
}

function buildBackup(rows, { now = new Date() } = {}) {
  return {
    format: 'vibecanvas-cloud_works',
    formatVersion: 1,
    createdAt: now.toISOString(),
    table: 'cloud_works',
    count: rows.length,
    rows: rows.map(pickColumns),
  };
}

/** 校验备份文件，返回 {ok, rows, problem}。 */
function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, rows: [], problem: '文件不是合法 JSON。' }; }
  if (!data || data.format !== 'vibecanvas-cloud_works') return { ok: false, rows: [], problem: '不是 VibeCanvas 作品备份文件。' };
  if (!Array.isArray(data.rows)) return { ok: false, rows: [], problem: '备份缺少 rows 列表。' };
  const rows = data.rows.filter((row) => row && typeof row.id === 'string' && typeof row.user_id === 'string' && row.document_json && typeof row.document_json === 'object');
  const skipped = data.rows.length - rows.length;
  return { ok: true, rows, skipped, createdAt: data.createdAt || null, problem: null };
}

/**
 * 按主键 id 覆盖写回。重复执行结果一致，所以恢复失败可以直接重跑。
 * dryRun 只校验不写入，适合先在线上跑一遍看会写多少行。
 */
async function importWorks(client, rows, { batchSize = 100, dryRun = false } = {}) {
  const valid = rows.filter((row) => row && typeof row.id === 'string' && typeof row.user_id === 'string' && row.document_json && typeof row.document_json === 'object');
  const skipped = rows.length - valid.length;
  if (dryRun) return { imported: 0, skipped, total: rows.length, dryRun: true };
  let imported = 0;
  for (let index = 0; index < valid.length; index += batchSize) {
    const batch = valid.slice(index, index + batchSize).map(pickColumns);
    await client.dbRequest('/cloud_works', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    });
    imported += batch.length;
  }
  return { imported, skipped, total: rows.length, dryRun: false };
}

/** 写回后逐个 id 抽查，确认行数和版本都回来了。 */
async function verifyWorks(client, ids, { batchSize = 50 } = {}) {
  const found = new Map();
  for (let index = 0; index < ids.length; index += batchSize) {
    const chunk = ids.slice(index, index + batchSize);
    const list = `(${chunk.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',')})`;
    const rows = await client.dbRequest(`/cloud_works?select=id,revision&id=in.${encodeURIComponent(list)}`);
    if (!Array.isArray(rows)) throw new Error('校验失败：接口返回的不是数据列表。');
    for (const row of rows) found.set(row.id, row.revision);
  }
  const missing = ids.filter((id) => !found.has(id));
  return { expected: ids.length, found: found.size, missing };
}

module.exports = { exportWorks, buildBackup, parseBackup, importWorks, verifyWorks, pickColumns, COLUMNS };
