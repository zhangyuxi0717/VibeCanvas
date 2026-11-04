'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* ----------------------------------------
 * 生产响应头、来源校验与静态资源
 * ---------------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// 只有这些路径会从磁盘读文件，别的一律 404，避免把仓库里的 .env 之类读出去。
const STATIC_PREFIXES = ['/vendor/', '/fonts/'];
const STATIC_FILES = ['/app.js', '/app.css', '/build.json', '/work-library.js', '/image-prompts.js', '/favicon.svg'];

function securityHeaders(config, noncePolicy = true) {
  const connect = ["'self'", 'https://*.supabase.co'];
  if (process.env.SUPABASE_URL) {
    try { connect.push(new URL(process.env.SUPABASE_URL).origin); } catch {}
  }
  // 开发模式直接加载 VibeCanvas.html 源码，页面里的 React、Tailwind、Babel
  // 都来自 CDN，JSX 还要靠 Babel 在浏览器里编译（需要 unsafe-eval）。
  // 生产模式读 public/ 构建产物，全部同源，保持最严格的策略。
  const dev = !config.production;
  const scriptSrc = dev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com', 'https://unpkg.com', 'https://cdn.jsdelivr.net']
    : ["'self'"];
  const styleSrc = dev
    ? ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']
    : ["'self'", "'unsafe-inline'"];
  const fontSrc = dev ? ["'self'", 'https://fonts.gstatic.com'] : ["'self'"];
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    // React 用 style 属性排版，必须允许内联样式；脚本仍然只允许同源文件。
    `style-src ${styleSrc.join(' ')}`,
    "img-src 'self' data: blob:",
    `font-src ${fontSrc.join(' ')}`,
    `connect-src ${[...new Set(connect)].join(' ')}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (config.security.hsts) headers['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  return headers;
}

// 请求的来源是否可信：同源，或在显式配置的 CORS 白名单里。
function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同源导航、curl、服务端调用不带 Origin
  if (config.appOrigin && origin === config.appOrigin) return true;
  const extra = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  // 开发时换了端口不该被挡；生产必须精确匹配 APP_ORIGIN，这里不放宽。
  if (!config.production) {
    try {
      const { protocol, hostname } = new URL(origin);
      if ((protocol === 'http:' || protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return true;
    } catch {}
  }
  return false;
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'local';
}

function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 返回 true 表示已经处理了请求。
 * 生产模式只读 public/；开发模式仍直接读 VibeCanvas.html，方便改完刷新就看见。
 */
function serveStatic(req, res, url, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\0')) return false;

  const isRoot = pathname === '/' || pathname === '/index.html';
  const allowed = isRoot || STATIC_FILES.includes(pathname) || STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!allowed) return false;

  const builtIndex = path.join(config.staticRoot, 'index.html');
  const useBuilt = config.production || process.env.SERVE_STATIC === 'true';
  const file = isRoot
    ? (useBuilt && fs.existsSync(builtIndex) ? builtIndex : path.join(__dirname, 'VibeCanvas.html'))
    : resolveStatic(pathname, config, useBuilt);

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;

  // 路径必须留在允许的根目录里，防止 ../ 穿越
  const roots = [config.staticRoot, __dirname].map((item) => path.resolve(item).toLowerCase());
  if (!roots.some((root) => path.resolve(file).toLowerCase().startsWith(root))) return false;

  const ext = path.extname(file).toLowerCase();
  const longCache = ['/vendor/', '/fonts/'].some((prefix) => pathname.startsWith(prefix));
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': fs.statSync(file).size,
    'Cache-Control': isRoot || pathname === '/app.js' || pathname === '/app.css' ? 'no-cache' : longCache ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...securityHeaders(config),
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

function resolveStatic(pathname, config, useBuilt) {
  if (useBuilt) {
    const candidate = path.join(config.staticRoot, pathname);
    if (fs.existsSync(candidate)) return candidate;
  }
  // 开发时 /work-library.js 这类模块直接从仓库根目录读
  if (STATIC_FILES.includes(pathname) && !useBuilt) return path.join(__dirname, pathname);
  return path.join(config.staticRoot, pathname);
}

module.exports = { securityHeaders, originAllowed, clientIp, serveStatic };
