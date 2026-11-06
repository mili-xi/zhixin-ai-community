import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { applyDouyinAiCover } from '../src/adapters/douyin-ai-cover.mjs';

async function fixture(t, {missing=false, wrong=false, stale=false}={}) {
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<div class="coverControl-test"><div class="cover-test">选择封面</div>横封面4:3</div><div class="coverControl-test"><div class="cover-test">选择封面</div>竖封面3:4</div><button id="publish">发布</button>`);
  await page.evaluate(({missing,wrong,stale})=>{
    window.published=0; document.querySelector('#publish').onclick=()=>window.published++;
    document.querySelectorAll('.cover-test').forEach((preview,index)=>preview.onclick=()=>{
      const modal=document.createElement('div');modal.setAttribute('role','dialog');
      modal.innerHTML=`设置${index?'竖':'横'}封面<div>AI封面</div>${missing?'': '<div class="candidate"><div class="aiCover-test" style="width:100px;height:100px;background-image:url(data:image/png;base64,AA)"><i class="aiTag-test"></i></div></div>'}<button>完成</button>`;
      document.body.append(modal);
      modal.querySelector('.aiCover-test')?.addEventListener('click',()=>setTimeout(()=>modal.querySelector('.candidate').classList.add('active-test'),30));
      modal.querySelector('button').onclick=()=>{
        if(!modal.querySelector('.active-test'))throw Error('not selected');
        modal.remove();
        if(stale)return;
        setTimeout(()=>{
          const c=document.createElement('canvas'); c.width=wrong?10:index?81:108; c.height=wrong?10:index?108:81;
          const img=new Image();img.src=c.toDataURL();preview.replaceChildren(img);
        },30);
      };
    });
    if(stale)document.querySelectorAll('.cover-test').forEach((preview,index)=>{
      const c=document.createElement('canvas');c.width=index?81:108;c.height=index?108:81;
      const img=new Image();img.src=c.toDataURL();preview.replaceChildren(img);
    });
  },{missing,wrong,stale});
  return page;
}
test('AI covers await native selection and asynchronous horizontal/vertical application without publishing',async t=>{
  const page=await fixture(t);const events=[];
  const result=await applyDouyinAiCover(page,{onProgress:async e=>events.push(e),timeoutMs:2000});
  assert.equal(result.source,'platform_ai');assert.equal(result.verified,true);
  assert.equal(result.horizontal.width,108);assert.equal(result.vertical.height,108);
  assert.equal(events[0].stage,'ai_cover');assert.equal(await page.evaluate(()=>window.published),0);
});
test('missing AI recommendation fails before completing a cover',async t=>{
  const page=await fixture(t,{missing:true});
  await assert.rejects(applyDouyinAiCover(page,{timeoutMs:150}),/DOUYIN_AI_COVER_UNAVAILABLE/);
  assert.equal(await page.locator('[role=dialog]').count(),1);
});
test('wrong-aspect cover is not accepted as applied',async t=>{
  const page=await fixture(t,{wrong:true});
  await assert.rejects(applyDouyinAiCover(page,{timeoutMs:250}),/DOUYIN_AI_COVER_NOT_APPLIED/);
});
test('previous cover with correct aspect is not evidence of a newly applied AI cover',async t=>{
  const page=await fixture(t,{stale:true});
  await assert.rejects(applyDouyinAiCover(page,{timeoutMs:250}),/DOUYIN_AI_COVER_NOT_APPLIED/);
});
