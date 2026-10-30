// 生产构建：把 VibeCanvas.html 里的运行时编译和 CDN 依赖换成可重复生成的本地资源。
//
// 输入（仓库里的唯一真源）：VibeCanvas.html
// 输出：public/  ——  index.html、app.js、app.css、vendor/*、fonts/*、两个小模块
//
// 不引入打包器魔法：JSX 用 esbuild 编译成普通脚本，样式用 Tailwind CLI 生成，
// 第三方库直接从 node_modules 复制对应版本，全部由 package-lock.json 固定。
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const fail = (message) => { console.error(`构建失败：${message}`); process.exit(1); };

const html = read('VibeCanvas.html');

/* ---------- 1. 取出内联的 JSX 与 <style> ---------- */
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) fail('VibeCanvas.html 里找不到 <style> 块');
const jsxMatch = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!jsxMatch) fail('VibeCanvas.html 里找不到 <script type="text/babel"> 块');

// 去掉 Google Fonts 的 @import：字体改成自托管，构建时复制 woff2 到 public/fonts。
const styleText = styleMatch[1]
  .replace(/@import\s+url\(["']https:\/\/fonts\.googleapis\.com[^)]*\);\s*/g, '')
  .trim();

/* ---------- 2. 干净输出目录 ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });

/* ---------- 3. 编译 JSX ---------- */
const jsxBanner = `// 由 scripts/build.mjs 从 VibeCanvas.html 的内联脚本生成，请勿直接编辑。\n`;
await build({
  stdin: { contents: jsxMatch[1], loader: 'jsx', resolveDir: ROOT, sourcefile: 'VibeCanvas.jsx' },
  bundle: false,          // React 等由前面的 vendor 脚本提供，保持原有全局约定
  format: 'iife',
  target: ['es2019'],
  minify: true,
  legalComments: 'none',
  banner: { js: jsxBanner },
  outfile: path.join(OUT, 'app.js'),
  logLevel: 'warning',
});

/* ---------- 4. Tailwind + 现有自定义样式 ---------- */
const cssInput = [
  '@tailwind base;',
  '@tailwind components;',
  '@tailwind utilities;',
  fontFaces(),
  styleText,
].join('\n');
const tmpCss = path.join(ROOT, '.build-input.css');
fs.writeFileSync(tmpCss, cssInput);
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
    '-c', path.join(ROOT, 'tailwind.config.js'),
    '-i', tmpCss,
    '-o', path.join(OUT, 'app.css'),
    '--minify',
  ], { cwd: ROOT, stdio: 'inherit' });
} finally {
  fs.rmSync(tmpCss, { force: true });
}

/* ---------- 5. 第三方库与字体 ---------- */
const VENDOR = {
  'node_modules/react/umd/react.production.min.js': 'vendor/react.production.min.js',
  'node_modules/react-dom/umd/react-dom.production.min.js': 'vendor/react-dom.production.min.js',
  'node_modules/lucide/dist/umd/lucide.min.js': 'vendor/lucide.min.js',
  'node_modules/@supabase/supabase-js/dist/umd/supabase.js': 'vendor/supabase.js',
  'node_modules/html2canvas/dist/html2canvas.min.js': 'vendor/html2canvas.min.js',
  'node_modules/jszip/dist/jszip.min.js': 'vendor/jszip.min.js',
};
for (const [from, to] of Object.entries(VENDOR)) {
  if (!fs.existsSync(path.join(ROOT, from))) fail(`缺少依赖文件 ${from}，请先运行 npm ci`);
  fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));
}
for (const file of ['work-library.js', 'image-prompts.js', 'favicon.svg']) {
  fs.copyFileSync(path.join(ROOT, file), path.join(OUT, file));
}

const FONT_FILES = [
  'dm-sans-latin-400-normal.woff2', 'dm-sans-latin-500-normal.woff2',
  'dm-sans-latin-600-normal.woff2', 'dm-sans-latin-700-normal.woff2',
  'space-grotesk-latin-400-normal.woff2', 'space-grotesk-latin-500-normal.woff2',
  'space-grotesk-latin-600-normal.woff2', 'space-grotesk-latin-700-normal.woff2',
];
for (const file of FONT_FILES) {
  const family = file.startsWith('dm-sans') ? 'dm-sans' : 'space-grotesk';
  const src = path.join(ROOT, 'node_modules', `@fontsource/${family}`, 'files', file);
  if (!fs.existsSync(src)) fail(`缺少字体文件 ${src}`);
  fs.copyFileSync(src, path.join(OUT, 'fonts', file));
}

/* ---------- 6. 生成 index.html ---------- */
const vendorTags = [
  '<script src="/vendor/react.production.min.js"></script>',
  '<script src="/vendor/react-dom.production.min.js"></script>',
  '<script src="/vendor/lucide.min.js"></script>',
  '<script src="/vendor/supabase.js"></script>',
  '<script src="/vendor/html2canvas.min.js"></script>',
  '<script src="/vendor/jszip.min.js"></script>',
].join('\n    ');

let out = html;
const beforeHead = (out.match(/<script[^>]*src="https:\/\/[^"]+"[^>]*><\/script>/g) || []).length;
if (beforeHead !== 8) fail(`预期的 8 个 CDN 脚本，实际找到 ${beforeHead} 个；VibeCanvas.html 结构变了，请同步更新 scripts/build.mjs`);
out = out.replace(/[ \t]*<script[^>]*src="https:\/\/[^"]+"[^>]*><\/script>\r?\n/g, '');
out = out.replace(styleMatch[0], '<link rel="stylesheet" href="/app.css">');
out = out.replace(jsxMatch[0], '<script src="/app.js"></script>');
out = out.replace('</head>', `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n    ${vendorTags.replace(/\n {4}/g, '\n    ')}\n  </head>`);
// 删掉只给 CDN 用的分区注释和随之留下的空行，避免产物里留一串空注释
out = out.replace(/[ \t]*<!--\s*(Tailwind CSS|React|JSX 编译|Lucide 图标|画布导出)\s*-->\r?\n/g, '');
out = out.replace(/\n{3,}/g, '\n\n');

for (const marker of ['/app.css', '/app.js', 'vendor/react.production.min.js', 'cdn.']) {
  if (marker === 'cdn.' ? out.includes('cdn.') : !out.includes(marker)) fail(`index.html 生成异常：${marker}`);
}

// 用内容哈希做缓存串，文件名不变、内容变了浏览器就会重新下载。
const hash = (file) => createHash('sha256').update(fs.readFileSync(path.join(OUT, file))).digest('hex').slice(0, 10);
out = out.replace('/app.css"', `/app.css?v=${hash('app.css')}"`).replace('/app.js"', `/app.js?v=${hash('app.js')}"`);

fs.writeFileSync(path.join(OUT, 'index.html'), out);

/* ---------- 7. 构建清单 ---------- */
const manifest = { builtAt: new Date().toISOString(), files: {} };
for (const file of ['index.html', 'app.js', 'app.css']) {
  manifest.files[file] = createHash('sha256').update(fs.readFileSync(path.join(OUT, file))).digest('hex');
}
fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`构建完成：${path.relative(ROOT, OUT)}/`);
console.log(`  index.html  ${(fs.statSync(path.join(OUT, 'index.html')).size / 1024).toFixed(1)} KB`);
console.log(`  app.js      ${(fs.statSync(path.join(OUT, 'app.js')).size / 1024).toFixed(1)} KB`);
console.log(`  app.css     ${(fs.statSync(path.join(OUT, 'app.css')).size / 1024).toFixed(1)} KB`);

function fontFaces() {
  const families = [
    { name: 'DM Sans', file: 'dm-sans', weights: [400, 500, 600, 700] },
    { name: 'Space Grotesk', file: 'space-grotesk', weights: [400, 500, 600, 700] },
  ];
  return families.flatMap(({ name, file, weights }) => weights.map((weight) => `@font-face {
  font-family: "${name}";
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url("/fonts/${file}-latin-${weight}-normal.woff2") format("woff2");
}`)).join('\n');
}
