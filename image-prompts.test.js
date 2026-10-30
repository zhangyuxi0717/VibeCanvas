const test=require('node:test');const assert=require('node:assert/strict');
const {TEMPLATE_IDS,MAX_LENGTH,BASE_MAX,buildPrompts}=require('./image-prompts');

const sample='夏日傍晚的校园草坪，一把木吉他斜靠在野餐垫旁，远处有模糊的年轻身影围坐，暖橙夕阳与青绿草地对比，低角度近景，右侧留白。';

test('三套模板各得一段提示词，且互不相同',()=>{
 const prompts=buildPrompts(sample);
 assert.deepEqual(Object.keys(prompts).sort(),[...TEMPLATE_IDS].sort());
 const values=TEMPLATE_IDS.map(id=>prompts[id]);
 assert.equal(new Set(values).size,3,'三段提示词必须不一样，否则生成的图会和以前一样重复');
 for(const value of values){assert.ok(value.startsWith(sample.slice(0,-1)));assert.ok(value.length<=MAX_LENGTH);assert.match(value,/请勿添加文字/);}
});

test('每段提示词带着对应模板的构图要求',()=>{
 const prompts=buildPrompts(sample);
 assert.match(prompts.minimal,/留白/);
 assert.match(prompts.visual,/近景|特写/);
 assert.match(prompts.magazine,/对角线/);
});

test('空描述和非法输入直接报错',()=>{
 assert.throws(()=>buildPrompts('   '),/不能为空/);
 assert.throws(()=>buildPrompts(null),/必须是文本/);
});

test('超长描述被截断，但仍然派生出三段不同的提示词',()=>{
 const long='校园'.repeat(400);
 const prompts=buildPrompts(long);
 for(const id of TEMPLATE_IDS){assert.ok(prompts[id].length<=MAX_LENGTH);}
 assert.equal(new Set(TEMPLATE_IDS.map(id=>prompts[id])).size,3);
 assert.ok(prompts.minimal.length>BASE_MAX,'模板要求没有被截掉');
});

test('结尾标点被规整，不会出现“…。。构图要求”',()=>{
 const prompts=buildPrompts('校园草坪音乐会。');
 assert.ok(!prompts.minimal.includes('。。'));
});

test('有英文描述时全部走英文，不再混进中文',()=>{
 const en='A wooden guitar leaning on a picnic blanket on a campus lawn at golden hour';
 const prompts=buildPrompts(sample,en);
 for(const id of TEMPLATE_IDS){
  assert.ok(prompts[id].startsWith(en));
  assert.equal(/[一-鿿]/.test(prompts[id]),false,`${id} 的提示词里不该有中文：${prompts[id]}`);
  assert.match(prompts[id],/no text, no letters, no logo, no watermark/);
 }
 assert.match(prompts.minimal,/negative space/);
 assert.match(prompts.visual,/close-up/);
 assert.match(prompts.magazine,/diagonal/);
 assert.equal(new Set(TEMPLATE_IDS.map(id=>prompts[id])).size,3);
});

test('英文里带中文或为空时退回中文，而不是报错',()=>{
 const fallback=buildPrompts(sample);
 for(const bad of ['', '   ', null, undefined, '一幅校园插画，绿色', 'campus 草坪']){
  const prompts=buildPrompts(sample,bad);
  assert.deepEqual(prompts,fallback,`英文描述 ${JSON.stringify(bad)} 应退回中文`);
 }
});

test('近千字符的英文不被腰斩，三段提示词仍在上限内',()=>{
 const en='An open campus lawn in summer with a checkered picnic blanket, a wooden acoustic guitar, soft backlit light and a large clean sky for text space, '.repeat(8);
 const prompts=buildPrompts(sample,en);
 for(const id of TEMPLATE_IDS){
  assert.ok(prompts[id].length<=MAX_LENGTH,`${id} 超过 ${MAX_LENGTH}`);
  assert.equal(/[一-鿿]/.test(prompts[id]),false);
  assert.ok(prompts[id].length>700,`${id} 被截得太短，构图信息会丢`);
 }
 assert.equal(new Set(TEMPLATE_IDS.map(id=>prompts[id])).size,3);
});

test('模型重复给的中文尾部没被带进英文提示词',()=>{
 const prompts=buildPrompts(sample,'guitar on a lawn, no text, no letters, no logo, no watermark');
 assert.equal(prompts.minimal.match(/no text/gi).length,1);
 assert.ok(!prompts.minimal.includes(',,'));
});
