# 多页小红书图文与批量导出实现计划

**目标：** 在现有单页 VibeCanvas 上增加连续多页图文生成、编辑、自动保存兼容和 PNG/ZIP 导出。

**架构：** 后端扩展结构化 carousel 输出校验；前端将作品统一扩展为 pages 数组并保留单页兼容读取；导出复用当前 DOM 渲染，逐页生成 1080x1440 PNG 后打包 ZIP。

**技术栈：** 原生 React CDN、现有 html2canvas、浏览器 Compression Streams（ZIP 手写最小打包器）、IndexedDB。

**文件：**
- 修改 `server.js`：carousel 请求与输出校验。
- 修改 `work-library.js`：多页记录验证、旧记录升级、复制深拷贝。
- 修改 `VibeCanvas.html`：生成模式、页面编辑/排序、批量导出和保存状态。
- 修改 `README.md`：使用说明与限制。

## 任务
- [x] 添加后端 carousel schema 与 `/api/generate` mode 分支。
- [x] 扩展作品库验证和旧单页升级。
- [x] 扩展前端 state、页面条、逐页编辑与排序。
- [x] 实现 1080x1440 当前页 PNG 和整组 ZIP 导出。
- [x] 接入自动保存、作品库恢复和兼容提示。
- [x] 更新文档并执行现有测试及手动浏览器检查。
