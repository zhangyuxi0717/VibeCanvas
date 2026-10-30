#!/usr/bin/env node
/**
 * 边界情况检查：移动端、慢网络、模型失败、额度耗尽。
 *
 *   node scripts/resilience.mjs
 *
 * 自己起一个假模型服务，不花钱、不依赖外网；
 * 移动端和慢网络两项打的是 E2E_BASE 指向的那个已部署服务（默认 https://127.0.0.1:8443）。
 * 登录过期是服务端行为，用 node --test trial-guard.test.js 覆盖。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../server');
const { loadConfig } = require('../config');
const { createTelemetry } = require('../telemetry');

process.env.SERVE_STATIC = 'true';

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:8443';
const EDGE = process.env.E2E_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = path.join(process.cwd(), '.tmp-test-data', 'resilience');
fs.mkdirSync(SHOTS, { recursive: true });

const CONTENT = {
  title: '校园读书会', subtitle: '把喜欢的书带来分享', description: '周六下午在图书馆三层，带上最近在读的一本书。',
  tags: ['读书'], event: { time: '周六下午', location: null, organizer: null },
  publishCopy: { title: '校园读书会', body: '带上最近在读的一本书来图书馆三层。', tags: ['读书'] },
};

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
};

/* ---------- 假模型服务：/ok 正常返回，/fail 返回 500 ---------- */
const stub = http.createServer((req, res) => {
  if (req.url.startsWith('/fail')) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'upstream secret detail' } })); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(CONTENT) } }] }));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

/* ---------- 两个用于检查的临时服务 ---------- */
function startApp(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-resilience-'));
  const config = loadConfig({ DATA_DIR: dataDir, STATIC_ROOT: path.join(process.cwd(), 'public'), ...env });
  const app = createApp({
    apiKey: 'test-key', model: 'test-model',
    apiUrl: `http://127.0.0.1:${stubPort}${env.MODEL_PATH || '/ok'}`,
  }, config, createTelemetry({ dataDir, enabled: false }));
  return new Promise((resolve) => app.listen(0, '127.0.0.1', () => resolve({ app, base: `http://127.0.0.1:${app.address().port}`, dataDir })));
}

const broken = await startApp({ MODEL_PATH: '/fail' });
const quota = await startApp({ GENERATE_PER_USER_DAILY_LIMIT: '1', GENERATE_DAILY_LIMIT: '5' });

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-resilience-')),
  args: ['--ignore-certificate-errors', '--disable-gpu'],
});

const newPage = async () => {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  return page;
};

const generateOnce = async (page) => {
  await page.waitForFunction(() => document.body.innerText.includes('生成我的创意'), { timeout: 30000 });
  await page.click('textarea');
  await page.type('textarea', '校园读书会，周六下午', { delay: 5 });
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('生成我的创意'));
    button.click();
  });
};

try {
  /* ---------- 1. 移动端 ---------- */
  const mobile = await newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mobile.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await mobile.waitForFunction(() => document.body.innerText.includes('生成我的创意'), { timeout: 30000 });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await mobile.screenshot({ path: path.join(SHOTS, 'mobile-390.png'), fullPage: false });
  record('移动端 390×844 无横向溢出', overflow <= 1, `横向溢出 ${overflow}px`);
  const tapTarget = await mobile.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('生成我的创意'));
    const box = button.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
  record('移动端主按钮可点击且尺寸足够', tapTarget.height >= 40, `${tapTarget.width}×${tapTarget.height}`);
  await mobile.close();

  /* ---------- 2. 慢网络 ---------- */
  const slow = await newPage();
  const client = await slow.createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false, latency: 400,
    downloadThroughput: Math.round(400 * 1024 / 8), // 400 kbps
    uploadThroughput: Math.round(400 * 1024 / 8),
  });
  const startedSlow = Date.now();
  await slow.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let slowOk = true;
  await slow.waitForFunction(() => document.body.innerText.includes('生成我的创意'), { timeout: 30000 }).catch(() => { slowOk = false; });
  const slowMs = Date.now() - startedSlow;
  record('400kbps 下页面仍能加载', slowOk, `${(slowMs / 1000).toFixed(1)} 秒出现主按钮`);
  // 慢网络下生成时先有进度提示，不会一直白屏
  if (slowOk) {
    await generateOnce(slow);
    const showsProgress = await slow.waitForFunction(() => document.body.innerText.includes('正在请求模型') || document.body.innerText.includes('正在生成'), { timeout: 8000 }).then(() => true).catch(() => false);
    record('慢网络下生成有进度提示', showsProgress);
  }
  await slow.close();

  /* ---------- 3. 模型失败 ---------- */
  const failing = await newPage();
  await failing.goto(broken.base, { waitUntil: 'networkidle2', timeout: 45000 });
  await generateOnce(failing);
  const failureText = await failing.waitForFunction(
    () => document.querySelector('#prompt-error')?.textContent?.trim() || false,
    { timeout: 30000 },
  ).then((handle) => handle.jsonValue()).catch(() => '');
  const leaks = /upstream secret detail|127\.0\.0\.1:\d+|at .*\.js:\d+/.test(failureText);
  record('模型失败时页面给出可操作的提示', Boolean(failureText), failureText.slice(0, 40));
  record('模型失败的提示不泄露内部细节', Boolean(failureText) && !leaks);
  await failing.screenshot({ path: path.join(SHOTS, 'model-failure.png'), fullPage: false });
  await failing.close();

  /* ---------- 4. 额度耗尽 ---------- */
  const limited = await newPage();
  await limited.goto(quota.base, { waitUntil: 'networkidle2', timeout: 45000 });
  await generateOnce(limited);
  await limited.waitForFunction(() => document.body.innerText.includes('3 DESIGNS READY'), { timeout: 30000 }).catch(() => {});
  await generateOnce(limited).catch(() => {});
  const quotaText = await limited.waitForFunction(
    () => document.querySelector('#prompt-error')?.textContent?.match(/额度/) ? document.querySelector('#prompt-error').textContent.trim() : false,
    { timeout: 30000 },
  ).then((handle) => handle.jsonValue()).catch(() => '');
  record('额度用完后提示清晰', Boolean(quotaText), quotaText.slice(0, 40));
  await limited.screenshot({ path: path.join(SHOTS, 'quota-exhausted.png'), fullPage: false });
  await limited.close();
} finally {
  await browser.close();
  for (const item of [broken, quota]) await new Promise((resolve) => item.app.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 项通过，截图在 ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
