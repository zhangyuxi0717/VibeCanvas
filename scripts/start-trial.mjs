#!/usr/bin/env node
/**
 * 用 Cloudflare 临时隧道（trycloudflare.com）把本机服务给几个朋友看。
 *
 *   npm run trial
 *   PORT=3004 npm run trial          # 换端口
 *   CLOUDFLARED=D:\tools\cloudflared.exe npm run trial
 *
 * 做的事：
 *   1. 起 cloudflared，拿一个随机 https 地址；
 *   2. 用「生产配置 + 那个地址」起本服务（不监听公网，只给隧道连 127.0.0.1）；
 *   3. 把地址打印出来，Ctrl+C 同时停掉两边。
 *
 * 注意：临时隧道每次重启都会换地址，而浏览器作品是按地址隔离的——
 * 换了地址，用户之前存在浏览器里的作品就看不到了。要固定地址需要自有域名 + 命名隧道。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const CLOUDFLARED = process.env.CLOUDFLARED
  || (process.platform === 'win32' ? 'C:/tmp/cloudflared/cloudflared.exe' : '/usr/local/bin/cloudflared');

if (!fs.existsSync(CLOUDFLARED) && !process.env.CLOUDFLARED) {
  console.error(`找不到 cloudflared：${CLOUDFLARED}`);
  console.error('请先安装，或用 CLOUDFLARED=<可执行文件路径> npm run trial 指定位置。');
  process.exit(2);
}
if (!fs.existsSync(path.join(process.cwd(), 'public', 'index.html'))) {
  console.error('缺少 public/index.html，先运行 npm run build。');
  process.exit(2);
}

let tunnel = null;
let app = null;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [app, tunnel]) {
    if (child && child.exitCode === null) {
      try { child.kill(); } catch {}
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log('正在建立 Cloudflare 临时隧道…');
tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://${HOST}:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let buffer = '';
const onTunnelOutput = (chunk) => {
  const text = chunk.toString();
  buffer = (buffer + text).slice(-8000);
  // cloudflared 把地址打在 stderr 里，格式形如 https://xxx-yyy.trycloudflare.com
  const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !app) startApp(match[0]);
};
tunnel.stdout.on('data', onTunnelOutput);
tunnel.stderr.on('data', onTunnelOutput);
tunnel.on('exit', (code) => {
  if (!stopping) {
    console.error(`隧道进程退出（code ${code}），服务一并停止。`);
    stop(1);
  }
});

const timeout = setTimeout(() => {
  if (!app) {
    console.error('60 秒内没拿到隧道地址。检查网络能否连到 Cloudflare，或看上面的 cloudflared 输出。');
    stop(1);
  }
}, 60000);

function startApp(origin) {
  clearTimeout(timeout);
  console.log(`隧道地址：${origin}`);
  console.log('正在用生产配置启动服务（读取 .env，监听 127.0.0.1，由隧道转发）…\n');

  app = spawn(process.execPath, ['--env-file=.env', 'server.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST,
      PORT: String(PORT),
      APP_ORIGIN: origin,
      BEHIND_TLS_PROXY: 'true',
      TRUST_PROXY: 'true',
      // 没有 Supabase 时无法按邮箱限制，只能靠「链接只发给受邀的人」+ 额度上限。
      ...(process.env.SUPABASE_URL ? {} : { TRIAL_OPEN: 'true' }),
    },
  });

  app.on('exit', (code) => {
    if (!stopping) {
      console.error(`服务退出（code ${code}），隧道一并停止。`);
      stop(code || 1);
    }
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`  把下面这个地址发给试用的人：\n  ${origin}`);
  console.log('\n  自检：' + origin + '/readyz');
  console.log('  停止：在本窗口按 Ctrl+C，隧道和服务同时关闭');
  console.log('════════════════════════════════════════════════\n');
}
