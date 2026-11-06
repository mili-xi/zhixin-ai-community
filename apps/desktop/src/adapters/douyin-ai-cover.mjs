// Native AI recommendations only. A raw video frame or an open editor is not
// evidence that an AI cover was selected and applied.
async function waitUntil(read, timeoutMs, code) {
  const end=Date.now()+timeoutMs;
  do { const value=await read(); if(value)return value; await new Promise(r=>setTimeout(r,100)); } while(Date.now()<end);
  throw new Error(code);
}
async function uniqueVisible(locator, code) {
  const visible=[];
  for(let i=0;i<await locator.count();i++)if(await locator.nth(i).isVisible())visible.push(locator.nth(i));
  if(visible.length!==1)throw new Error(code);
  return visible[0];
}
export async function applyDouyinAiCover(page,{onProgress,timeoutMs=180000}={}) {
  await onProgress?.({type:'publish_progress',stage:'ai_cover',message:'正在生成并应用抖音AI封面'});
  const evidence={source:'platform_ai',verified:false};
  for(const [key,label,title,ratio] of [['horizontal','横封面4:3','设置横封面',4/3],['vertical','竖封面3:4','设置竖封面',3/4]]) {
    const control=await uniqueVisible(page.locator('[class^="coverControl-"]').filter({hasText:label}),'DOUYIN_AI_COVER_CONTROL_NOT_IDENTIFIED');
    const beforeSources=await control.locator('img').evaluateAll(es=>es.map(e=>e.currentSrc||e.src));
    // The observed first direct child is the preview/click target; the second
    // child is its orientation caption. No global same-name button matching.
    await control.locator(':scope > div').first().click();
    const modal=page.locator('[role="dialog"]').filter({hasText:title});
    await modal.waitFor({state:'visible',timeout:30000});
    await modal.getByText('AI封面',{exact:true}).click();
    // Opening this tab starts native generation. Repeatedly pressing generate
    // would create extra resource jobs, so await its actual recommended card.
    const candidate=await waitUntil(async()=>{
      const cards=modal.locator('[class^="aiCover-"]').filter({has:page.locator('[class^="aiTag-"]')});
      for(let i=0;i<await cards.count();i++) {
        const card=cards.nth(i);
        if(await card.isVisible() && await card.evaluate(e=>Boolean(e.style.backgroundImage)&&e.style.backgroundImage!=='none'))return card;
      }
      return null;
    },timeoutMs,'DOUYIN_AI_COVER_UNAVAILABLE');
    // The platform's first AI recommendation is the default, not an arbitrary
    // photo from the timeline or the reference-image gallery.
    await candidate.click();
    await waitUntil(()=>candidate.evaluate(e=>[...e.parentElement.classList].some(c=>c.startsWith('active-'))),timeoutMs,'DOUYIN_AI_COVER_NOT_SELECTED');
    const complete=await uniqueVisible(modal.getByRole('button',{name:'完成',exact:true}),'DOUYIN_AI_COVER_CONFIRM_NOT_IDENTIFIED');
    await waitUntil(()=>complete.isEnabled(),timeoutMs,'DOUYIN_AI_COVER_NOT_READY');
    await complete.click();
    await modal.waitFor({state:'hidden',timeout:30000});
    evidence[key]=await waitUntil(async()=>{
      const images=await control.locator('img').evaluateAll(es=>es.map(e=>({source:e.currentSrc||e.src,loaded:e.complete,width:e.naturalWidth,height:e.naturalHeight})));
      if(images.length!==1)return null;
      const value=images[0];
      return !beforeSources.includes(value.source) && value.loaded && value.width>0 && value.height>0 && Math.abs(value.width/value.height-ratio)<0.02 ? {width:value.width,height:value.height,verified:true} : null;
    },timeoutMs,'DOUYIN_AI_COVER_NOT_APPLIED');
  }
  return {...evidence,verified:true};
}
