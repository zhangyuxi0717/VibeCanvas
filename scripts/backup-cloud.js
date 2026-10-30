#!/usr/bin/env node
'use strict';
/**
 * 导出云端作品库（Supabase cloud_works 表）到本地 JSON。
 *
 *   node --env-file=.env.production scripts/backup-cloud.js [输出目录]
 *
 * 需要 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY。只导出数据库行，不含 Storage 里的图片文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createSupabaseClient } = require('../cloud-store');
const { exportWorks, buildBackup } = require('../cloud-backup');

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，无法导出。');
    process.exit(2);
  }
  const outDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'backups'));
  const client = createSupabaseClient({ url, anonKey: process.env.SUPABASE_ANON_KEY || serviceKey, serviceKey });

  console.log('正在导出 cloud_works …');
  const rows = await exportWorks(client);
  const backup = buildBackup(rows);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = backup.createdAt.replace(/[:.]/g, '-');
  const file = path.join(outDir, `cloud_works-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`完成：${rows.length} 行 → ${file}`);
  console.log(`恢复：node --env-file=.env.production scripts/restore-cloud.js "${file}" --dry-run`);
}

main().catch((error) => { console.error('导出失败：' + (error?.message || '未知错误')); process.exit(1); });
