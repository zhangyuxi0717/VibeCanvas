#!/usr/bin/env node
'use strict';
/**
 * 把备份文件写回云端作品库（按主键 id 覆盖，重复执行结果一致）。
 *
 *   node --env-file=.env.production scripts/restore-cloud.js <备份文件> --dry-run
 *   node --env-file=.env.production scripts/restore-cloud.js <备份文件> --yes
 *
 * 不加 --yes 不会写入；先跑 --dry-run 看会写多少行。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createSupabaseClient } = require('../cloud-store');
const { parseBackup, importWorks, verifyWorks } = require('../cloud-backup');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((item) => !item.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const confirmed = args.includes('--yes');
  if (!file) { console.error('用法：restore-cloud.js <备份文件> [--dry-run] [--yes]'); process.exit(2); }
  if (!dryRun && !confirmed) { console.error('未写入：确认要覆盖云端作品请追加 --yes。'); process.exit(2); }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) { console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，无法恢复。'); process.exit(2); }

  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) { console.error('备份文件不存在：' + fullPath); process.exit(2); }
  const parsed = parseBackup(fs.readFileSync(fullPath, 'utf8'));
  if (!parsed.ok) { console.error('备份文件不可用：' + parsed.problem); process.exit(2); }

  console.log(`备份时间：${parsed.createdAt || '未知'}；有效行 ${parsed.rows.length}，跳过 ${parsed.skipped} 行。`);
  const client = createSupabaseClient({ url, anonKey: process.env.SUPABASE_ANON_KEY || serviceKey, serviceKey });

  if (dryRun) {
    const preview = await importWorks(client, parsed.rows, { dryRun: true });
    console.log(`演练完成：会写入 ${preview.total - preview.skipped} 行，跳过 ${preview.skipped} 行；没有改动云端数据。`);
    return;
  }

  const result = await importWorks(client, parsed.rows);
  console.log(`已写入 ${result.imported} 行，跳过 ${result.skipped} 行。正在校验 …`);
  const check = await verifyWorks(client, parsed.rows.map((row) => row.id));
  console.log(`校验：应存在 ${check.expected} 行，实际读到 ${check.found} 行，缺失 ${check.missing.length} 行。`);
  if (check.missing.length) {
    console.error('有行没有写回，请检查网络或权限后重跑同一条命令（可重复执行）。');
    process.exit(1);
  }
  console.log('恢复完成。');
}

main().catch((error) => { console.error('恢复失败：' + (error?.message || '未知错误')); process.exit(1); });
