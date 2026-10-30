const dns = require('node:dns').promises;
(async () => {
  try {
    const url = new URL(process.env.MODEL_API_URL || '');
    console.log('模型服务域名：', url.hostname);
    try { await dns.lookup(url.hostname); console.log('域名解析：成功'); }
    catch (err) { console.log('域名解析失败：', err.code || '未知'); return; }
    try {
      const response = await fetch(url.origin + '/', { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      console.log('已收到 HTTP 响应，状态码：' + response.status + '（这不代表模型接口可用）');
    } catch (err) {
      console.log('网络连接失败：', err.cause?.code || err.name);
    }
  } catch { console.log('MODEL_API_URL 未填写或地址格式无效'); }
})();
