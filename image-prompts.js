(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ImagePrompts=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';

 /* ----------------------------------------
  * 配图提示词派生
  *
  * 文本模型只返回一段配图描述（主体、场景、色彩、氛围）。
  * 这里把它派生成三套模板各一段：同一段内容，加上各自需要的
  * 构图和留白要求，让三张图真的长得不一样。
  *
  * 语言：本地 SDXL 的文本编码器读不懂中文，中文描述只会得到
  * 一张与内容无关的图。所以英文描述可用时一律走英文；没有英文
  * （比如用户手改后翻译失败）才退回中文，至少不报错。
  *
  * 纯函数，不碰网络、不碰 DOM，方便单测。
  * ---------------------------------------- */

 const TEMPLATE_IDS=['minimal','visual','magazine'];

 // 每套模板的构图要求。三条互不重叠，否则出来还是同一张图。
 const TEMPLATE_HINTS={
  minimal:'构图要求：单一主体居中偏上，背景干净，大面积留白，低饱和配色，不要细节堆叠。',
  visual:'构图要求：近景特写，主体占据画面上半部分六成以上，光线层次清楚，细节丰富。',
  magazine:'构图要求：主体偏置形成对角线，前景与背景分层，带拼贴感，四周保留可裁切的边距。',
 };
 const TEMPLATE_HINTS_EN={
  minimal:'Composition: one single subject placed centre-upper, clean background, generous negative space, muted low-saturation palette, no cluttered detail.',
  visual:'Composition: tight close-up, the subject fills more than sixty percent of the upper half, clear layered lighting, rich detail.',
  magazine:'Composition: subject offset along a diagonal, separate foreground and background layers, collage feel, keep crop-safe margins on all four sides.',
 };

 const SUFFIX_CN='请勿添加文字、字母、标志或水印。';
 const SUFFIX_EN='no text, no letters, no logo, no watermark.';

 const MAX_LENGTH=1400;
 const BASE_MAX=460;    // 给模板要求留出位置，整段不超过任务接口的 1400 字上限
 const BASE_MAX_EN=1000; // 英文同一段内容写开更长（约中文的三倍），加上构图要求仍要留在 1400 以内
 const CJK=/[一-鿿]/;

 function normalize(description){
  if(typeof description!=='string')throw Error('配图描述必须是文本。');
  const text=description.replace(/\s+/g,' ').trim().replace(/[。；;]+$/,'');
  if(!text)throw Error('配图描述不能为空。');
  return text.length>BASE_MAX?text.slice(0,BASE_MAX).replace(/[，,、]$/,''):text;
 }

 // 英文描述：不可用就返回 null，由调用方退回中文，不抛错——
 // 用户改中文描述后翻译可能失败，那时不该让整次生成挂掉。
 function normalizeEnglish(descriptionEn){
  if(typeof descriptionEn!=='string')return null;
  const text=descriptionEn.replace(/\s+/g,' ').trim().replace(/[.!;]+$/,'').replace(/\s*no text, ?no letters, ?no logo, ?no watermark\.?$/i,'').trim();
  if(!text)return null;
  if(CJK.test(text))return null;
  return text.length>BASE_MAX_EN?text.slice(0,BASE_MAX_EN).replace(/[,]$/,''):text;
 }

 function buildPrompts(description, descriptionEn){
  const base=normalize(description);
  const english=normalizeEnglish(descriptionEn);
  const hints=english?TEMPLATE_HINTS_EN:TEMPLATE_HINTS;
  const suffix=english?SUFFIX_EN:SUFFIX_CN;
  const joiner=english?' ':'。';
  const result={};
  for(const id of TEMPLATE_IDS){
   const prompt=`${english||base}${joiner}${hints[id]}${english?' ':''}${suffix}`;
   if(prompt.length>MAX_LENGTH)throw Error('派生的配图描述超长。');
   result[id]=prompt;
  }
  return result;
 }

 return {TEMPLATE_IDS,TEMPLATE_HINTS,TEMPLATE_HINTS_EN,MAX_LENGTH,BASE_MAX,BASE_MAX_EN,buildPrompts};
});
