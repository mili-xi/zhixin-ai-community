const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const TOPIC=/#([^\s#＃，。！？、；：,.!?;:]+)/gu;
export function extractDouyinTopics(caption){
 const names=[...String(caption).matchAll(TOPIC)].map(match=>match[1]);
 if(new Set(names).size!==names.length)throw new Error('DOUYIN_TOPIC_DUPLICATE');
 return names;
}
export function verifyNativeTopics(expected,nodes,suggestions){
 const actual=nodes.map(name=>name.trim().replace(/^#/,'').trim());
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('DOUYIN_NATIVE_TOPICS_NOT_APPLIED');
 return expected.map(name=>{
  const matches=[...new Map(suggestions.filter(row=>row.cha_name===name&&/^\d+$/.test(String(row.cid))).map(row=>[String(row.cid),row])).values()];
  if(matches.length!==1)throw new Error('DOUYIN_TOPIC_ID_NOT_VERIFIED');
  return {name,id:String(matches[0].cid)};
 });
}
export function validateSmartChapters(body){
 if(body?.status_code!==0||!Array.isArray(body.chapter_list)||!body.chapter_list.length||!String(body.chapter_abstract||'').trim())throw new Error('DOUYIN_SMART_CHAPTERS_UNAVAILABLE');
 let last=-1;
 const entries=body.chapter_list.map(row=>{
  const timestamp=Number(row.time_stamp),title=String(row.title||'').trim(),detail=String(row.detail||'');
  if(!Number.isFinite(timestamp)||timestamp<0||timestamp<=last||!title||title.includes('\ufffd')||detail.includes('\ufffd'))throw new Error('DOUYIN_SMART_CHAPTERS_INVALID');
  last=timestamp;return {time_stamp:timestamp,title,detail};
 });
 const summary=String(body.chapter_abstract);
 if(summary.includes('\ufffd'))throw new Error('DOUYIN_SMART_CHAPTERS_INVALID');
 return {source:'platform_smart',verified:true,count:entries.length,summary,entries};
}
function parseNativeField(value){
 if(typeof value!=='string')return value;
 // Tokenize quoted strings first, preserving escaped text. Only unquoted large
 // integer tokens become strings, including identifiers in challenge arrays.
 return JSON.parse(value.replace(/"(?:\\.|[^"\\])*"|(-?\d{16,})(?=\s*[,}\]])/g,(token,number)=>number?JSON.stringify(number):token));
}
export function verifyDouyinPreparedRequest(body,proof){
 try{
  if(!proof?.topics?.verified||!proof?.chapters?.verified||!proof.chapters.saved)return false;
  const expected=proof.topics.resolved;
  const topics=parseNativeField(body.item.common.text_extra).filter(row=>Number(row.type)===1);
  const challenges=parseNativeField(body.item.common.challenges).map(String);
  if(topics.length!==expected.length||challenges.length!==expected.length)return false;
  if(!expected.every((row,index)=>topics[index].hashtag_name===row.name&&String(topics[index].hashtag_id)===row.id&&challenges.includes(row.id)))return false;
  const chapter=parseNativeField(body.item.chapter.chapter);
  if(chapter.chapter_abstract!==proof.chapters.summary)return false;
  const actual=chapter.chapter_details;
  return Array.isArray(actual)&&actual.length===proof.chapters.entries.length&&proof.chapters.entries.every((row,index)=>actual[index].desc===row.title&&actual[index].detail===row.detail&&Number(actual[index].timestamp)===row.time_stamp);
 }catch{return false;}
}
async function nativeJson(response){
 const bytes=await response.body();
 let text=new TextDecoder('utf-8').decode(bytes);
 // The observed creator suggestion/recommend endpoints can return GB18030
 // despite Playwright's UTF-8 text default. Never accept replacement glyphs.
 if(text.includes('\ufffd'))text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);
 return JSON.parse(text.replace(/("(?:cid|challenge_id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,'$1"$2"'));
}
export async function applyDouyinTopics(page,caption,{onProgress,timeoutMs=20000}={}){
 const expected=extractDouyinTopics(caption),suggestions=[];
 await onProgress?.({type:'publish_progress',stage:'topics',message:'正在关联抖音原生话题'});
 const editor=page.locator('[contenteditable="true"][data-slate-editor="true"]');
 if(await editor.count()!==1)throw new Error('DOUYIN_CAPTION_EDITOR_NOT_IDENTIFIED');
 const listen=async response=>{try{const url=new URL(response.url());if(url.hostname==='creator.douyin.com'&&url.pathname==='/aweme/v1/search/challengesug/'){const body=await nativeJson(response);if(body.status_code===0)suggestions.push(...body.sug_list||[]);}}catch{}};
 page.on('response',listen);
 try{
  await editor.click();await editor.press('ControlOrMeta+A');await editor.press('Backspace');
  await page.waitForFunction(()=>!document.querySelector('[data-slate-editor]')?.innerText.replace(/[\s\u200b]/g,''));
  let offset=0;
  for(const match of String(caption).matchAll(TOPIC)){
   await page.keyboard.insertText(String(caption).slice(offset,match.index)+match[0]);
   const choice=page.getByText(match[0],{exact:true}).and(page.locator(':not([data-slate-editor] *)')).filter({visible:true});
   await choice.waitFor({state:'visible',timeout:timeoutMs});
   if(await choice.count()!==1)throw new Error('DOUYIN_TOPIC_SUGGESTION_AMBIGUOUS');
   await choice.click();
   await editor.locator('[data-mention="#"]').filter({hasText:match[0]}).waitFor({state:'attached',timeout:5000});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   offset=match.index+match[0].length;
  }
  await page.keyboard.insertText(String(caption).slice(offset));
  const nodes=await editor.locator('[data-mention="#"]').allTextContents();
  const entries=verifyNativeTopics(expected,nodes,suggestions);
  const actual=(await editor.innerText()).replace(/\u200b/g,'').replace(/\s+/gu,'').trim();
  if(actual!==String(caption).replace(/\s+/gu,'').trim())throw new Error('DOUYIN_CAPTION_NOT_APPLIED');
  return {source:'native',verified:true,count:entries.length,requested:expected,resolved:entries,entries};
 }finally{page.off('response',listen);}
}
export async function applyDouyinSmartChapters(page,{onProgress,timeoutMs=180000}={}){
 await onProgress?.({type:'publish_progress',stage:'chapters',message:'正在生成抖音智能章节要点'});
 let generated,problem;
 const listen=async response=>{try{const url=new URL(response.url());if(url.hostname==='creator.douyin.com'&&url.pathname==='/aweme/v1/chapter/recommend/get'){const body=await nativeJson(response);if(body.chapter_list?.length)generated=validateSmartChapters(body);else if(body.status_code!==0)problem=String(body.status_msg||body.status_code);}}catch(error){problem=error.message;}};
 page.on('response',listen);
 try{
  const open=page.getByText('智能章节已上线，试试吧',{exact:true});
  if(await open.isVisible())await open.click();else await page.getByText('去编辑',{exact:true}).click();
  const dialog=page.getByRole('dialog').filter({hasText:'章节要点'}).filter({visible:true});
  await dialog.waitFor({state:'visible',timeout:10000});
  await dialog.getByRole('button',{name:'智能生成',exact:true}).click();
  const until=Date.now()+timeoutMs;
  while(!generated&&Date.now()<until){if(problem)throw new Error(`DOUYIN_SMART_CHAPTERS_FAILED: ${problem}`);await pause(300);}
  if(!generated)throw new Error('DOUYIN_SMART_CHAPTERS_GENERATION_TIMEOUT');
  for(const entry of generated.entries)await dialog.getByText(entry.title,{exact:true}).first().waitFor({state:'visible',timeout:10000});
  const text=await dialog.innerText();
  if(!generated.entries.every(row=>text.includes(row.title)))throw new Error('DOUYIN_SMART_CHAPTERS_PREVIEW_MISMATCH');
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await dialog.waitFor({state:'hidden',timeout:15000});
  await page.getByText(`当前已添加${generated.count}条章节&摘要`,{exact:true}).waitFor({state:'visible',timeout:15000});
  return {...generated,saved:true};
 }finally{page.off('response',listen);}
}
