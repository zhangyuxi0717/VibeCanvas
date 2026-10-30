'use strict';
// Checks only the HTTP status and an allowlisted error category; never prints credentials or response bodies.
(async () => {
  const {MODEL_API_URL: url, MODEL_API_KEY: key, MODEL_NAME: model} = process.env;
  if (!url || !key || !model) { console.log('配置不完整，请检查 .env。'); return; }
  try {
    const response = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`},
      body:JSON.stringify({model, messages:[{role:'user',content:'请回复：测试成功'}], max_tokens:16}),
      signal:AbortSignal.timeout(30000)
    });
    console.log('模型接口状态：HTTP ' + response.status);
    if (response.ok) { console.log('模型请求成功。'); return; }
    let data = {}; try { data = await response.json(); } catch {}
    const allowed = new Set(['invalid_api_key','insufficient_quota','model_not_found','invalid_request_error','rate_limit_exceeded','unsupported_country_region_territory','organization_deactivated']);
    const code = data?.error?.code || data?.error?.type;
    if (allowed.has(code)) console.log('错误类别：' + code);
    else console.log('错误类别：未能安全识别');
  } catch (err) { console.log('连接失败：' + (err.cause?.code || err.name)); }
})();
