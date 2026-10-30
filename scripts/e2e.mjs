#!/usr/bin/env node
/**
 * 端到端验收：新用户 → 生成 → 编辑 → 保存 → 重新打开 → 导出。
 *
 *   node scripts/e2e.mjs
 *   E2E_BASE=https://127.0.0.1:8443 node scripts/e2e.mjs
 *
 * 用本机已安装的 Edge 跑无头浏览器，不下载 Chromium。
 * 「新用户」= 每次新建一个空的浏览器配置目录，IndexedDB 里没有任何作品。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:8443';
const EDGE = process.env.E2E_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DOWNLOAD_DIR = path.join(process.cwd(), '.tmp-test-data', 'e2e-downloads');
const PROMPT = process.env.E2E_PROMPT || '吉他社招新，周三晚七点，大学生活动中心，欢迎喜欢音乐的同学';
const TITLE = '吉他社招新啦';

const steps = [];
const step = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
};
const fail = (name, detail) => { step(name, false, detail); throw new Error(`${name}：${detail}`); };

async function clickByText(page, text, { tag = 'button', timeout = 15000 } = {}) {
  const handle = await page.waitForFunction((tagName, label) => {
    const nodes = [...document.querySelectorAll(tagName)];
    const target = nodes.find((node) => node.textContent.replace(/\s+/g, '').includes(label));
    if (!target || target.disabled) return false;
    target.click();
    return true;
  }, { timeout, polling: 200 }, tag, text.replace(/\s+/g, ''));
  if (!handle) throw new Error(`找不到按钮：${text}`);
}

async function textOf(page, selector) {
  return page.$eval(selector, (node) => node.textContent).catch(() => '');
}

async function main() {
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-e2e-'));
  const startedAt = Date.now();

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    userDataDir: profile,
    args: ['--ignore-certificate-errors', '--window-size=1440,1000', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 1000 },
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  const cspViolations = [];
  const missing = [];
  page.on('response', (response) => { if (response.status() === 404) missing.push(response.url()); });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });

    // 1. 新用户打开：没有作品，界面可用
    await page.waitForFunction(() => document.body.innerText.includes('生成我的创意'), { timeout: 20000 });
    const initialTitle = await page.$eval('input[placeholder="输入你的海报标题"]', (node) => node.value).catch(() => null);
    step('新用户打开页面', initialTitle === null || initialTitle === '你的校园灵感', initialTitle === null ? '尚未生成，编辑区未出现（正常）' : `默认标题「${initialTitle}」`);

    // 2. 生成
    await page.click('textarea');
    await page.type('textarea', PROMPT, { delay: 8 });
    await clickByText(page, '生成我的创意');
    // 三张预览卡片一开始就在，不能拿卡片数量当「生成完成」的信号；
    // 生成成功后右上角徽标会变成 3 DESIGNS READY。
    await page.waitForFunction(() => document.body.innerText.includes('3 DESIGNS READY'), { timeout: 120000 });
    const firstCardTitle = await textOf(page, '.result-card');
    step('生成文案并出现三套模板', true, firstCardTitle.trim().slice(0, 24));

    // 3. 选一套进入编辑
    await page.click('.result-card');
    await page.waitForSelector('input[placeholder="输入你的海报标题"]', { timeout: 15000 });
    const generatedTitle = await page.$eval('input[placeholder="输入你的海报标题"]', (node) => node.value);
    step('点击卡片进入编辑', generatedTitle.length > 0, `模型给出标题「${generatedTitle}」`);

    // 4. 编辑标题，等自动保存
    await page.click('input[placeholder="输入你的海报标题"]', { clickCount: 3 });
    await page.type('input[placeholder="输入你的海报标题"]', TITLE, { delay: 10 });
    await page.waitForFunction(() => document.body.innerText.includes('已保存'), { timeout: 20000 });
    step('编辑标题后自动保存', true, `新标题「${TITLE}」`);

    // 5. 重新打开（刷新页面，等同重新进入）
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('input[placeholder="输入你的海报标题"]', { timeout: 20000 });
    const restoredTitle = await page.$eval('input[placeholder="输入你的海报标题"]', (node) => node.value);
    restoredTitle === TITLE ? step('刷新后作品被恢复', true, `标题仍是「${restoredTitle}」`) : fail('刷新后作品被恢复', `期望「${TITLE}」，实际「${restoredTitle}」`);

    // 6. 导出 PNG
    await clickByText(page, '下载当前海报');
    const deadline = Date.now() + 60000;
    let file = null;
    while (Date.now() < deadline) {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.png'));
      if (files.length) { file = files[0]; break; }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!file) fail('导出海报 PNG', '60 秒内没有生成下载文件');
    const full = path.join(DOWNLOAD_DIR, file);
    const buffer = fs.readFileSync(full);
    const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) fail('导出海报 PNG', '下载的文件不是 PNG');
    step('导出海报 PNG', true, `${file}（${(buffer.length / 1024).toFixed(0)} KB）`);

    // 7. 前端没有报错、没有违反 CSP
    const csp = await page.evaluate(() => window.__csp || []);
    cspViolations.push(...csp);
    csp.length ? step('页面无 CSP 违规', false, csp.join('；')) : step('页面无 CSP 违规', true);
    consoleErrors.length ? step('浏览器控制台无报错', false, [...new Set(consoleErrors)].slice(0, 3).join(' | ')) : step('浏览器控制台无报错', true);
    missing.length ? step('没有加载失败的文件', false, [...new Set(missing)].slice(0, 3).join(' | ')) : step('没有加载失败的文件', true);

    // 8. 落盘的产品事件：只该有白名单事件名，且不含正文
    const eventsDir = path.resolve(process.env.E2E_EVENTS_DIR || path.join(process.cwd(), 'data', 'events'));
    const since = startedAt;
    const readEvents = () => {
      const list = [];
      if (!fs.existsSync(eventsDir)) return list;
      for (const name of fs.readdirSync(eventsDir).filter((file) => file.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(path.join(eventsDir, name), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (Date.parse(record.ts) >= since) list.push(record);
          } catch { /* 半行写入，跳过 */ }
        }
      }
      return list;
    };
    // 前端每 5 秒或攒够 10 条才发送，导出事件要等它刷出去
    let recorded = readEvents();
    for (let waited = 0; waited < 20000 && !recorded.some((record) => record.name === 'export'); waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      recorded = readEvents();
    }
    const allowed = new Set(['generate_start', 'generate_success', 'generate_fail', 'image_start', 'image_success', 'image_fail', 'edit', 'export', 'save', 'open_work', 'feedback_open']);
    const unknown = recorded.filter((record) => !allowed.has(record.name)).map((record) => record.name);
    const leaked = JSON.stringify(recorded.filter((record) => record.name)).includes(PROMPT) || JSON.stringify(recorded).includes(TITLE);
    const names = [...new Set(recorded.map((record) => record.name))];
    const hasCore = ['generate_start', 'generate_success', 'edit', 'export'].every((name) => names.includes(name));
    if (!hasCore) step('产品事件已落盘', false, `缺少核心事件，实际：${names.join(', ') || '无'}`);
    else if (unknown.length) fail('产品事件只有白名单事件', unknown.join(', '));
    else if (leaked) fail('产品事件不含正文', '事件文件里出现了提示词或标题原文');
    else step('产品事件已落盘且不含正文', true, names.join(', '));

    await browser.close();
    const failed = steps.filter((item) => !item.ok);
    console.log(`\n${steps.length - failed.length} / ${steps.length} 步通过，下载目录：${DOWNLOAD_DIR}`);
    process.exit(failed.length ? 1 : 0);
  } catch (error) {
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, 'e2e-failure.png') }).catch(() => {});
    console.error('\n验收中断：' + error.message);
    console.error('已截图：' + path.join(DOWNLOAD_DIR, 'e2e-failure.png'));
    if (consoleErrors.length) console.error('控制台报错：\n  ' + consoleErrors.slice(0, 5).join('\n  '));
    await browser.close();
    process.exit(1);
  }
}

main();
