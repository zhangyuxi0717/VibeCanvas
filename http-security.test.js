'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { securityHeaders } = require('./http-security');

// 开发模式直接读 VibeCanvas.html，它的脚本来自 CDN、JSX 由 Babel 在内联脚本里编译。
// 如果这里和页面加载方式不一致，浏览器只会显示一个空页面，接口却一切正常。
test('development CSP allows the CDN scripts that VibeCanvas.html loads', () => {
  const csp = securityHeaders({ production: false, security: { hsts: false } })['Content-Security-Policy'];
  assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval' https:\/\/cdn\.tailwindcss\.com https:\/\/unpkg\.com https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
});

// 生产读 public/ 构建产物，脚本全部同源，不能因为开发放宽而一起放宽。
test('production CSP still only allows same-origin scripts', () => {
  const csp = securityHeaders({ production: true, security: { hsts: false } })['Content-Security-Policy'];
  assert.match(csp, /script-src 'self';/);
  assert.ok(!csp.includes('unpkg.com'));
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(!csp.includes("'unsafe-inline' https"));
});
