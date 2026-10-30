#!/usr/bin/env node
'use strict';
/**
 * 上线前自检：只读当前环境变量，打印「会怎么跑」和「缺什么」，不启动服务。
 * 不打印任何密钥，只打印是否配置。
 *
 *   node --env-file=.env.production scripts/check-config.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');

const config = loadConfig();
const yes = (value) => (value ? '已配置' : '未配置');
const lines = [];
const row = (label, value) => lines.push(`  ${label.padEnd(26)}${value}`);

lines.push(`环境：${config.profile}`);
row('监听地址', `${config.host}:${config.port}${config.tls.enabled ? '（Node 直接 HTTPS）' : ''}`);
row('对外地址 APP_ORIGIN', config.appOrigin || '（未设置）');
row('TLS 证书', config.tls.enabled ? '已配置' : (process.env.BEHIND_TLS_PROXY === 'true' ? '由反向代理终止' : '无'));
row('HSTS', config.security.hsts ? '开启' : '关闭');
row('静态产物', fs.existsSync(path.join(config.staticRoot, 'index.html')) ? `${config.staticRoot}/index.html` : '缺失（先 npm run build）');
row('数据目录 DATA_DIR', config.dataDir);
row('模型服务', yes(process.env.MODEL_API_URL && process.env.MODEL_API_KEY));
row('视觉（照片理解）', yes(process.env.VISION_API_URL && process.env.VISION_API_KEY));
row('配图服务', process.env.IMAGE_SERVICE_ENABLED === 'false' ? '已关闭' : yes((process.env.IMAGE_API_URL && process.env.IMAGE_API_KEY) || process.env.COMFYUI_API_URL || process.env.LOCAL_IMAGE_PATH));
row('Supabase 云端', config.cloud.configured ? '已配置' : (config.cloud.required ? '未配置（但要求必须配置）' : '未配置（仅本地作品）'));
row('试用名单人数', config.trial.allowedEmails.length ? `${config.trial.allowedEmails.length} 人 / 上限 ${config.trial.maxUsers} 人` : `不限（上限 ${config.trial.maxUsers} 人的设置未生效）`);
row('每日生成额度', `总计 ${config.trial.generateDailyLimit}，每人 ${config.trial.generatePerUserDailyLimit}`);
row('每日配图额度', `总计 ${config.trial.imageDailyLimit}，每人 ${config.trial.imagePerUserDailyLimit}`);
row('付费闭环', config.billing.enabled ? `开启（${config.billing.provider}），每张配图 ${config.billing.creditsPerTask} 额度` : '关闭');
if (config.billing.enabled) {
  row('商品表', config.billing.products.length
    ? config.billing.products.map((item) => `${item.id} ¥${(item.priceFen / 100).toFixed(2)} / ${item.credits} 额度`).join('；')
    : '（空）');
  row('运营接口', config.billing.adminToken ? '已配置' : '未配置（/api/admin/* 不开放）');
}
row('产品事件', config.telemetry.enabled ? '开启' : '关闭');

console.log(lines.join('\n'));

if (config.warnings.length) {
  console.log('\n提示：');
  for (const line of config.warnings) console.log('  - ' + line);
}
if (config.errors.length) {
  console.log('\n未通过：');
  for (const line of config.errors) console.log('  - ' + line);
  console.log('\n请补齐后再启动；服务不会带着这些配置启动。');
  process.exit(1);
}
console.log('\n配置检查通过，可以启动。');
