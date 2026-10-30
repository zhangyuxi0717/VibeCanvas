'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, insideTempDir, uniqueEmails } = require('./config');

// 造一个「看起来可以上线」的目录：有 index.html 的静态目录 + 非临时目录的数据目录
function scaffold({ withIndex = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-config-'));
  const staticRoot = path.join(root, 'public');
  fs.mkdirSync(staticRoot, { recursive: true });
  if (withIndex) fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html>');
  return { root, staticRoot, dataDir: path.join(process.cwd(), '.tmp-test-data', path.basename(root)) };
}

const prodEnv = (extra = {}) => ({
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://canvas.example.cn',
  BEHIND_TLS_PROXY: 'true',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  TRIAL_ALLOWED_EMAILS: 'a@example.com',
  ...extra,
});

test('开发环境缺变量也能起来，默认监听本机', () => {
  const config = loadConfig({});
  assert.equal(config.profile, 'development');
  assert.equal(config.production, false);
  assert.deepEqual(config.errors, []);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.appOrigin, 'http://127.0.0.1:3000');
});

test('生产环境缺少 APP_ORIGIN 直接不通过', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ APP_ORIGIN: '', STATIC_ROOT: staticRoot, DATA_DIR: dataDir }));
  assert.equal(config.ok, false);
  assert.ok(config.errors.some((line) => line.includes('APP_ORIGIN')));
});

test('生产环境 APP_ORIGIN 必须是 https', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ APP_ORIGIN: 'http://canvas.example.cn', STATIC_ROOT: staticRoot, DATA_DIR: dataDir }));
  assert.ok(config.errors.some((line) => line.includes('https://')));
});

test('生产环境没有构建产物时提示先 build', () => {
  const { staticRoot, dataDir } = scaffold({ withIndex: false });
  const config = loadConfig(prodEnv({ APP_ORIGIN: '', STATIC_ROOT: staticRoot, DATA_DIR: dataDir }));
  assert.ok(config.errors.some((line) => line.includes('index.html')));
});

test('数据目录落在系统临时目录会被拦下', () => {
  const { staticRoot } = scaffold();
  const config = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: path.join(os.tmpdir(), 'vc-data') }));
  assert.ok(config.errors.some((line) => line.includes('临时目录')));
  assert.equal(insideTempDir(path.join(os.tmpdir(), 'x')), true);
  assert.equal(insideTempDir(path.join(process.cwd(), 'data')), false);
});

test('生产环境没说 TLS 也没说在代理后面会被拦下', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ BEHIND_TLS_PROXY: '', STATIC_ROOT: staticRoot, DATA_DIR: dataDir }));
  assert.ok(config.errors.some((line) => line.includes('BEHIND_TLS_PROXY')));
});

test('没配 Supabase 时只给提示，不阻止启动', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' }));
  assert.deepEqual(config.errors, []);
  assert.equal(config.cloud.configured, false);
  assert.ok(config.warnings.some((line) => line.includes('Supabase')));
});

test('CLOUD_REQUIRED=true 而 Supabase 未配置时拒绝启动', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir, CLOUD_REQUIRED: 'true', SUPABASE_URL: '' }));
  assert.ok(config.errors.some((line) => line.includes('Supabase')));
});

test('生产环境试用名单为空时拒绝启动，除非显式开放', () => {
  const { staticRoot, dataDir } = scaffold();
  const blocked = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir, TRIAL_ALLOWED_EMAILS: '' }));
  assert.ok(blocked.errors.some((line) => line.includes('TRIAL_ALLOWED_EMAILS')));

  const open = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir, TRIAL_ALLOWED_EMAILS: '', TRIAL_OPEN: 'true' }));
  assert.deepEqual(open.errors, []);
  assert.ok(open.warnings.some((line) => line.includes('TRIAL_OPEN')));
});

test('名单人数超过 TRIAL_MAX_USERS 时拒绝启动', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir, TRIAL_ALLOWED_EMAILS: 'a@x.com,b@x.com,c@x.com', TRIAL_MAX_USERS: '2' }));
  assert.ok(config.errors.some((line) => line.includes('TRIAL_MAX_USERS')));
});

test('完整配置的生产环境可以通过', () => {
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir }));
  assert.deepEqual(config.errors, []);
  assert.equal(config.ok, true);
  assert.equal(config.tls.enabled, false);
  assert.equal(config.security.hsts, true); // 生产默认开
});

test('名单会去空格、转小写并去重', () => {
  assert.deepEqual(uniqueEmails(' A@Example.com , b@example.com,a@example.com ,'), ['a@example.com', 'b@example.com']);
  const { staticRoot, dataDir } = scaffold();
  const config = loadConfig(prodEnv({ STATIC_ROOT: staticRoot, DATA_DIR: dataDir, TRIAL_ALLOWED_EMAILS: 'X@Y.com, x@y.com' }));
  assert.deepEqual(config.trial.allowedEmails, ['x@y.com']);
});
