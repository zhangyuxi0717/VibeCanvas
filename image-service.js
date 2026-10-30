'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const MAX_BYTES=12*1024*1024;
const TRUSTED_IMAGE_HOSTS=new Set(['oaidalleapiprodscus.blob.core.windows.net','images.openai.com']);
async function readLimited(response, limit) {const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>limit)throw Error('image too large');chunks.push(chunk)}return Buffer.concat(chunks);}
function createOpenAIImageService({apiKey,apiUrl,model,size='1024x1024',timeoutMs=120000,fetchImpl=fetch}){
 return async prompt=>{
  if (!apiKey || !apiUrl || !model || apiKey.startsWith('your-')) throw Error('unconfigured');
  const api=new URL(apiUrl);if(api.protocol!=='https:' || api.username || api.password)throw Error('invalid configuration');
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   const response=await fetchImpl(api.toString(),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,prompt:prompt+'。请勿主动添加文字、字母、标志或水印，保留适合独立排版的留白。',n:1,size}),redirect:'error',signal:controller.signal});
   const id=response.headers?.get('x-request-id') || ''; const requestId=/^[a-zA-Z0-9_-]{1,120}$/.test(id)?id:null;
   if(!response.ok){const error=Error('provider error');error.requestId=requestId;error.providerStatus=response.status;throw error;}
   const body=response.body ? JSON.parse((await readLimited(response,Math.ceil(MAX_BYTES/3)*4+1024*1024)).toString('utf8')) : await response.json(),item=body?.data?.[0]; if(!item)throw Error('invalid output');let bytes;
   if(typeof item.b64_json==='string') {if(item.b64_json.length>Math.ceil(MAX_BYTES/3)*4 || /[^A-Za-z0-9+/=]/.test(item.b64_json))throw Error('invalid image'); bytes=Buffer.from(item.b64_json,'base64');}
   else if(typeof item.url==='string') {const target=new URL(item.url);if(target.protocol!=='https:'||target.username||target.password||target.port||!TRUSTED_IMAGE_HOSTS.has(target.hostname))throw Error('untrusted image');const remote=await fetchImpl(target.toString(),{redirect:'error',signal:controller.signal});if(!remote.ok)throw Error('image fetch failed');bytes=await readLimited(remote,MAX_BYTES);}
   else throw Error('invalid output');
   if(!bytes.length||bytes.length>MAX_BYTES)throw Error('invalid image');
   const sharp=require('sharp');const meta=await sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}).metadata();const mime={png:'image/png',jpeg:'image/jpeg',webp:'image/webp'}[meta.format];if(!mime || !meta.width || !meta.height)throw Error('invalid image');
   const usage=body.usage && typeof body.usage==='object' ? Object.fromEntries(['input_tokens','output_tokens','total_tokens'].filter(k=>Number.isFinite(body.usage[k])).map(k=>[k,body.usage[k]])) : undefined;
   return {data:bytes,mime,requestId,usage};
  } finally {clearTimeout(timer)}
 };
}
function createLocalImageService({filePath,maxBytes=12*1024*1024}={}){
 return async()=>{if(!filePath)throw Error('unconfigured');const resolved=path.resolve(filePath);const stat=fs.statSync(resolved);if(!stat.isFile()||stat.size>maxBytes)throw Error('invalid image');const ext=path.extname(resolved).toLowerCase();const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[ext];if(!mime)throw Error('invalid image');return {data:fs.readFileSync(resolved),mime,requestId:'local-file',usage:undefined};};
}
function createImageTasks({service,maxConcurrent=2,dailyLimit=20,perUserDailyLimit=dailyLimit,perMinute=5,queueLimit=20,ttlMs=30*60*1000,logger=console.log,now=()=>Date.now(),storePath=null,assetDir=null,enabled=true,onStatus=null}={}){
 const tasks=new Map(),ids=new Map(),queue=[];let active=0,day='',count=0,attempts=[],userCounts=new Map();
 // 状态变化往上层报一份，额度结算靠它；回调出错不能影响任务本身。
 function notifyStatus(task,status){if(typeof onStatus!=='function')return;try{onStatus(task,status)}catch(err){try{logger({event:'on_status_failed',taskId:task?.id,status,error:err.message})}catch{}}}
 const stateFile=storePath&&path.resolve(storePath);const resultDir=path.resolve(assetDir||((stateFile&&path.dirname(stateFile))||process.cwd()),'generation-assets');
 function writeState(){if(!stateFile)return;fs.mkdirSync(path.dirname(stateFile),{recursive:true});const tmp=stateFile+'.tmp';const serial=[...tasks.values()].map(t=>({...t,result:t.result?{...t.result,data:undefined}:undefined}));fs.writeFileSync(tmp,JSON.stringify({day,count,userCounts:[...userCounts],tasks:serial}));fs.renameSync(tmp,stateFile);}
 function loadState(){if(!stateFile||!fs.existsSync(stateFile))return;try{const data=JSON.parse(fs.readFileSync(stateFile,'utf8'));day=data.day||'';count=Number(data.count)||0;userCounts=new Map(data.userCounts||[]);for(const raw of data.tasks||[]){const task={...raw};if(task.status==='running'||task.status==='queued')task.status='uncertain',task.error='服务重启时任务状态未知；请确认供应商状态后再手动发起新任务。';if(task.result?.file){const file=path.join(resultDir,task.result.file);if(fs.existsSync(file))task.result={...task.result,data:fs.readFileSync(file)};else {task.status='failed';task.error='任务结果文件已丢失。';}}tasks.set(task.id,task);if(task.key)ids.set(`${task.ownerId||'guest'}:${task.key}`,task.id);}}catch{}}
 loadState();
 function prune(){const t=now();for(const [id,task] of tasks){if(['completed','failed','cancelled','uncertain'].includes(task.status)&&t-task.updated>=ttlMs){if(task.result?.file){try{fs.rmSync(path.join(resultDir,task.result.file),{force:true})}catch{}}tasks.delete(id);ids.delete(`${task.ownerId||'guest'}:${task.key}`);}}attempts=attempts.filter(x=>x>t-60000);writeState()}
 function get(id,ownerId='guest'){prune();const task=tasks.get(id);if(!task||task.ownerId!==ownerId)return undefined;return task}
 function publicTask(task){if(!task)return task;const copy={...task};if(copy.result){copy.result={mime:copy.result.mime,requestId:copy.result.requestId||null,usage:copy.result.usage};}delete copy.prompt;delete copy.key;delete copy.ownerId;return copy;}
 function providerError(err){const status=Number(err.providerStatus);return {message:err.name==='AbortError'?'图片服务请求超时，供应商可能已经受理本次请求，请确认后再手动重试。':status===401||status===403?'图片服务鉴权失败，请确认 IMAGE_API_KEY 属于图片服务且模型有权限。':status===404?'图片接口地址或图片模型不存在，请检查 IMAGE_API_URL 和 IMAGE_MODEL_NAME。':status===429?'图片服务额度或频率受限，请稍后重试。':'配图生成失败，请检查图片服务配置后手动重试；服务商可能已经受理本次请求。',status:err.name==='AbortError'?'uncertain':'failed'};}
 function pump(){while(active<maxConcurrent&&queue.length){const task=queue.shift();if(task.status!=='queued')continue;active++;task.status='running';task.updated=now();writeState();const started=now();Promise.resolve().then(()=>service(task.prompt)).then(result=>{task.status='completed';task.result={...result,file:null};fs.mkdirSync(resultDir,{recursive:true});const file=`${task.id}.bin`;fs.writeFileSync(path.join(resultDir,file),result.data);task.result={...task.result,file,data:undefined};task.updated=now();logger({event:'image_request',taskId:task.id,durationMs:now()-started,result:'completed',requestId:result.requestId||null,...(result.usage?{usage:result.usage}:{})});notifyStatus(task,'completed');}).catch(err=>{const outcome=providerError(err);task.status=outcome.status;task.error=outcome.message;task.providerRequestId=err.requestId||null;task.updated=now();logger({event:'image_request',taskId:task.id,durationMs:now()-started,result:task.status,requestId:err.requestId||null});notifyStatus(task,task.status);}).finally(()=>{active--;writeState();pump()});}}
 function create(key,prompt,{ownerId='guest',enabledOverride=enabled}={}){prune();if(!enabledOverride)throw Error('图片生成服务已暂停，暂不接受新的付费请求。');if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw Error('请求标识无效。');const scoped=`${ownerId}:${key}`;if(ids.has(scoped)){const existing=tasks.get(ids.get(scoped));if(existing?.prompt!==prompt)throw Error('请求标识已用于其他内容。');return publicTask(existing)}if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1400)throw Error('配图描述须为 1–1400 字。');if(tasks.size>=queueLimit+maxConcurrent)throw Error('生成队列已满，请稍后重试。');const today=new Date(now()).toISOString().slice(0,10);if(day!==today){day=today;count=0;userCounts=new Map()}const userCount=userCounts.get(ownerId)||0;if(count>=dailyLimit)throw Error('全局图片请求已达上限。');if(userCount>=perUserDailyLimit)throw Error('你的今日图片额度已用完。');if(attempts.length>=perMinute)throw Error('请求过于频繁，请稍后重试。');const task={id:crypto.randomUUID(),key,prompt,ownerId,status:'queued',created:now(),updated:now(),quota:{reserved:true,charged:true,refund:false}};tasks.set(task.id,task);ids.set(scoped,task.id);queue.push(task);count++;userCounts.set(ownerId,userCount+1);attempts.push(now());writeState();pump();return publicTask(task);}
 function cancel(id,ownerId='guest'){const task=get(id,ownerId);if(!task)throw Error('任务不存在或无权访问。');if(task.status!=='queued')throw Error('任务已经发起，无法取消；若供应商可能已受理，不会自动重试。');task.status='cancelled';task.updated=now();task.error='用户取消。';task.quota.cancelled=true;writeState();notifyStatus(task,'cancelled');return publicTask(task);}
 function result(id,ownerId='guest'){const task=get(id,ownerId);if(!task||task.status!=='completed'||!task.result?.file)return null;const file=path.join(resultDir,task.result.file);if(!fs.existsSync(file))return null;return {...task.result,data:fs.readFileSync(file)};}
 // 内部对账用：不做过期清理，也不按 owner 过滤。
 function peek(id){return tasks.get(id)||null}
 function list(limit=30){const max=Math.min(Math.max(Number(limit)||30,1),200);return [...tasks.values()].sort((a,b)=>b.created-a.created).slice(0,max).map(task=>({id:task.id,ownerId:task.ownerId||'guest',status:task.status,created:task.created,updated:task.updated,error:task.error||null,providerRequestId:task.providerRequestId||null,result:task.result?{mime:task.result.mime,requestId:task.result.requestId||null,durationMs:task.result.durationMs||null}:null}))}
 return {create,get:(id,owner)=>publicTask(get(id,owner)),result,cancel,prune,peek,list,stats:()=>({active,queued:queue.length,total:tasks.size,dailyCount:count,userCounts:new Map(userCounts)})};
}
module.exports={createImageTasks,createOpenAIImageService,createLocalImageService};
