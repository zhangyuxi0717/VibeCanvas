/** @type {import('tailwindcss').Config} */
module.exports = {
  // 只扫描源码：VibeCanvas.html 里的内联 JSX 和 <style>。
  // 构建产物 public/ 不参与扫描，避免自己扫自己。
  content: ['./VibeCanvas.html'],
  theme: { extend: {} },
  plugins: [],
};
