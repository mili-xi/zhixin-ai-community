import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinAdapter, parseDouyinJson, douyinAccountProfile, douyinCreateResult, douyinPublicationResult } from '../src/adapters/douyin.mjs';

const itemId = '7561234567890123456';
test('Douyin JSON preserves numeric identifiers before JSON parsing', () => {
  assert.equal(parseDouyinJson('{"item_id":7561234567890123456,"status_code":0}').item_id, itemId);
});
test('create acknowledgement is accepted for review, never proof of public visibility', () => {
  const result = douyinCreateResult({status_code:0,item_id:itemId});
  assert.equal(result.itemId,itemId);
  assert.equal(result.platformStatus,'submitted_for_review');
  assert.equal(result.submissionAccepted,true);
  assert.equal(result.publicUrl,undefined);
  assert.equal(douyinCreateResult({status_code:0}).platformStatus,'submission_unknown');
  assert.equal(douyinCreateResult({status_code:8,item_id:itemId}).platformStatus,'failed');
});
test('profile requires server supplied identity, never a supplied display name or a cookie', () => {
  assert.equal(douyinAccountProfile({status_code:0,data:{nickname:'Account'}}),null);
  assert.equal(douyinAccountProfile({status_code:1,data:{uid:'123',nickname:'Account'}}),null);
  assert.deepEqual(douyinAccountProfile({status_code:0,data:{uid:'123',nickname:'Account'}}),{accountId:'123',accountName:'Account',avatar:''});
});
const publicWork = {aweme_id:itemId,status_value:102,status:{self_see:false,is_delete:false,is_private:false,is_prohibited:false}};
const detail = {id:itemId,review:{status:2},visibility:{}};
test('public status requires independent matching work and detail evidence', () => {
  assert.equal(douyinPublicationResult(itemId,[publicWork],[detail]).platformStatus,'published');
  assert.deepEqual(douyinPublicationResult(itemId,[publicWork],[detail]).publicationEvidence,{workListVerified:true,detailVerified:true});
  assert.equal(douyinPublicationResult(itemId,[publicWork],[{...detail,visibility:{unknown:true}}]).found,false);
  assert.equal(douyinPublicationResult(itemId,[publicWork],[]).platformStatus,'submitted_for_review');
  assert.equal(douyinPublicationResult(itemId,[{...publicWork,aweme_id:'999'}],[detail]).found,false);
  assert.equal(douyinPublicationResult(itemId,[{...publicWork,status:{...publicWork.status,self_see:true}}],[detail]).found,false);
  assert.equal(douyinPublicationResult(itemId,[{...publicWork,status:{...publicWork.status,is_private:true}}],[detail]).found,false);
  assert.equal(douyinPublicationResult(itemId,[{...publicWork,status_value:141}],[detail]).platformStatus,'submitted_for_review');
});
function fakeAdapter({response={status_code:0,item_id:itemId}, clickError=false, accountId='123'}={}) {
  const adapter = new DouyinAdapter();
  const calls=[];
  adapter.openWorkspace=async()=>({context:{close:async()=>calls.push('close')},page:{},state:{}});
  adapter.requireIdentity=async()=>({accountId});
  adapter.prepareVideo=async()=>calls.push('upload');
  adapter.submitVideo=async()=>{calls.push('click'); if(clickError)throw new Error('lost connection'); return response;};
  return {adapter,calls};
}
test('publish persists submitting before single native submit', async()=>{
  const {adapter,calls}=fakeAdapter();
  const result=await adapter.publishVideo({videoPath:'video.mp4',caption:'caption',expectedAccountId:'123',onProgress:async e=>calls.push(e.stage)});
  assert.equal(result.itemId,itemId);
  assert.ok(calls.indexOf('submitting')<calls.indexOf('click'));
  assert.equal(calls.filter(x=>x==='click').length,1);
});
test('failure to persist submitting prevents the click', async()=>{
  const {adapter,calls}=fakeAdapter();
  await assert.rejects(()=>adapter.publishVideo({videoPath:'video.mp4',expectedAccountId:'123',onProgress:async e=>{if(e.stage==='submitting')throw new Error('offline');}}),/offline/);
  assert.ok(!calls.includes('click'));
});
test('lost response is unknown and never retries the submit',async()=>{
  const {adapter,calls}=fakeAdapter({clickError:true});
  const result=await adapter.publishVideo({videoPath:'video.mp4',expectedAccountId:'123',onProgress:async()=>{}});
  assert.equal(result.platformStatus,'submission_unknown');
  assert.equal(calls.filter(x=>x==='click').length,1);
});
test('wrong account and absent expected account prevent upload and submission',async()=>{
  for(const expectedAccountId of ['456','']){
    const {adapter,calls}=fakeAdapter();
    await assert.rejects(()=>adapter.publishVideo({videoPath:'video.mp4',expectedAccountId,onProgress:async()=>{}}),/ACCOUNT/);
    assert.ok(!calls.includes('upload'));
    assert.ok(!calls.includes('click'));
  }
});
test('Douyin cannot inherit article fake publication behavior',async()=>{
  await assert.rejects(()=>new DouyinAdapter().publishArticle({title:'test'}),/VIDEO_ONLY/);
});

test('latest work evidence supersedes an earlier pending response',()=>{
  const pending={...publicWork,status_value:141,status:{...publicWork.status,self_see:true}};
  assert.equal(douyinPublicationResult(itemId,[pending,publicWork],[detail]).found,true);
  assert.equal(douyinPublicationResult(itemId,[publicWork,pending],[detail]).found,false);
});
test('unsafe already-rounded item identifiers cannot become accepted results',()=>{
  assert.equal(douyinCreateResult({status_code:0,item_id:Number(itemId)}).platformStatus,'submission_unknown');
});
test('native response observer consumes actual captured identity and detail shapes',async()=>{
  const {EventEmitter}=await import('node:events');
  const page=new EventEmitter();
  page.goto=async()=>{};
  const context={pages:()=>[page],close:async()=>{}};
  const adapter=new DouyinAdapter();
  adapter.launchAuthEnvironment=async()=>context;
  const workspace=await adapter.openWorkspace({});
  const emit=(path,body)=>page.emit('response',{url:()=>`https://creator.douyin.com${path}`,ok:()=>true,text:async()=>JSON.stringify(body)});
  emit('/web/api/media/user/info/',{status_code:0,user:{uid:'123',nickname:'Verified account'}});
  emit('/janus/douyin/creator/pc/work_list',{status_code:0,aweme_list:[publicWork]});
  emit('/web/api/creator/item/mget?ids='+itemId,{status_code:0,items:[detail]});
  await Promise.all([...workspace.state.pending]);
  assert.equal(workspace.state.profile.accountId,'123');
  assert.equal(douyinPublicationResult(itemId,workspace.state.works,workspace.state.details).found,true);
  workspace.state.detach();
  assert.equal(page.listenerCount('response'),0);
});

test('video readiness requires this upload commit, exact byte size and matching transcode resource',async()=>{
  const {douyinVideoReady}=await import('../src/adapters/douyin.mjs');
  const ready={encode:1,play_url:'https://example.invalid/play',poster_uri:'poster'};
  assert.equal(douyinVideoReady({commits:[{videoId:'v1',size:20}],transcodes:[{videoId:'old',body:ready}]},20),false);
  assert.equal(douyinVideoReady({commits:[{videoId:'v1',size:20}],transcodes:[{videoId:'v1',body:ready}]},21),false);
  assert.equal(douyinVideoReady({commits:[],transcodes:[{videoId:'v1',body:ready}]},20),false);
  assert.equal(douyinVideoReady({commits:[{videoId:'v1',size:20}],transcodes:[{videoId:'v1',body:ready}]},20),true);
});

test('discovery follows bounded cursors and never substitutes a different item',async()=>{
  const {readDouyinWorkList}=await import('../src/adapters/douyin.mjs');
  const calls=[];
  const page={evaluate:async(fn,route)=>{calls.push(route);return JSON.stringify(calls.length===1?{status_code:0,aweme_list:[{aweme_id:'999'}],has_more:true,max_cursor:'123'}:{status_code:0,aweme_list:[publicWork],has_more:false});}};
  const state={works:[]};
  await readDouyinWorkList(page,state,itemId);
  assert.equal(calls.length,2);
  assert.match(calls[1],/max_cursor=123/);
  assert.equal(state.works.at(-1).aweme_id,itemId);
  const endless={evaluate:async()=>JSON.stringify({status_code:0,aweme_list:[],has_more:true,max_cursor:'same'})};
  const missing={works:[]};
  await readDouyinWorkList(endless,missing,itemId);
  assert.equal(missing.works.length,0);
});

test('connected Chrome workspace closes only its own tab and never seeds the user context',async()=>{
  const {EventEmitter}=await import('node:events');
  const page=new EventEmitter();
  const calls=[];
  page.goto=async()=>calls.push('goto');page.close=async()=>calls.push('tab.close');
  const userContext={newPage:async()=>page,cookies:async()=>[],close:async()=>calls.push('context.close'),addCookies:async()=>calls.push('seed')};
  const connectedBrowser={contexts:()=>[userContext],close:async()=>calls.push('browser.close')};
  const adapter=new DouyinAdapter({connectedBrowser});
  adapter.launchAuthEnvironment=async()=>{throw new Error('should not launch');};
  const workspace=await adapter.openWorkspace({cookies:[{name:'must-not-seed',value:'x'}]});
  assert.deepEqual(await workspace.context.cookies(),[]);
  await workspace.context.close();
  assert.deepEqual(calls,['goto','tab.close']);
});

test('native create guard accepts only immediate public video requests',async()=>{
  const {isDouyinImmediatePublicVideo}=await import('../src/adapters/douyin.mjs');
  const common={media_type:4,timing:0,visibility_type:0};
  assert.equal(isDouyinImmediatePublicVideo({item:{common,sync:{should_sync:false,sync_to_toutiao:0}}}),true);
  assert.equal(isDouyinImmediatePublicVideo({item:{common:{...common,timing:1793037300}}}),false);
  assert.equal(isDouyinImmediatePublicVideo({item:{common:{...common,visibility_type:1}}}),false);
  assert.equal(isDouyinImmediatePublicVideo({item:{common:{...common,media_type:2}}}),false);
  assert.equal(isDouyinImmediatePublicVideo({}),false);
});

test('manual gate keeps waiting until visible blocker disappears and reports progress',async()=>{
  const {waitForDouyinManualVerification}=await import('../src/adapters/douyin.mjs');
  const calls=[];let checks=0;
  const dialogs={count:async()=>1,nth:()=>({isVisible:async()=>++checks===1})};
  const page={getByRole:()=>({filter:()=>dialogs}),bringToFront:async()=>calls.push('front')};
  await waitForDouyinManualVerification(page,{onProgress:async event=>calls.push(event.type)});
  assert.deepEqual(calls,['manual_verification_required','front','publish_progress']);
});

test('native submit guard aborts scheduled requests before network and permits immediate public unchanged',async()=>{
  for(const timing of [0,1793037300]){
    const state={createBodies:[],preparationEvidence:{topics:{verified:true,resolved:[]},chapters:{verified:true,saved:true,summary:'总结',entries:[{time_stamp:0,title:'引言',detail:''}]}}};const calls=[];let handler;
    const requestBody={item:{common:{media_type:4,timing,visibility_type:0},sync:{should_sync:false,sync_to_toutiao:0}}};
    Object.assign(requestBody.item.common,{text_extra:'[]',challenges:'[]'});
    requestBody.item.chapter={chapter:JSON.stringify({chapter_abstract:'总结',chapter_details:[{timestamp:0,desc:'引言',detail:''}]})};
    const button={isVisible:async()=>true,click:async()=>{calls.push('click');await handler({request:()=>({postDataJSON:()=>requestBody}),abort:async()=>calls.push('abort'),continue:async()=>{calls.push('continue');state.createBodies.push({status_code:0,item_id:itemId});}});}};
    const page={getByRole:()=>({count:async()=>1,nth:()=>button}),route:async(pattern,fn)=>{assert.ok(pattern.test('https://creator.douyin.com/web/api/media/aweme/create_v2/?aid=1128'));handler=fn;},unroute:async()=>calls.push('unroute')};
    const body=await new DouyinAdapter().submitVideo(page,state);
    assert.deepEqual(calls,['click',timing===0?'continue':'abort','unroute']);
    assert.equal(Boolean(body.client_blocked),timing!==0);
  }
});

test('authorization evidence requires scoped live login cookies and authenticated workspace identity',async()=>{
  const {douyinAuthorizationEvidence}=await import('../src/adapters/douyin.mjs');
  const cookie={name:'sessionid',value:'test-only',domain:'.douyin.com',expires:-1};
  const pageState={url:'https://creator.douyin.com/creator-micro/content/upload',title:'抖音创作者中心',text:'作品发布 上传视频'};
  const profile={accountId:'123',accountName:'Account'};
  const evidence=douyinAuthorizationEvidence([cookie],profile,pageState);
  assert.equal(evidence.strongCookiePresent,true);assert.equal(evidence.workspaceReady,true);
  assert.equal(evidence.currentUrl,pageState.url);assert.equal(evidence.pageTitle,pageState.title);
  assert.equal(douyinAuthorizationEvidence([],profile,pageState).strongCookiePresent,false);
  assert.equal(douyinAuthorizationEvidence([{...cookie,domain:'.evil-douyin.com'}],profile,pageState).strongCookiePresent,false);
  assert.equal(douyinAuthorizationEvidence([{...cookie,expires:1}],profile,pageState).strongCookiePresent,false);
  assert.equal(douyinAuthorizationEvidence([cookie],{},pageState).workspaceReady,false);
  assert.equal(douyinAuthorizationEvidence([cookie],profile,{...pageState,url:'https://creator.douyin.com/login'}).workspaceReady,false);
});
test('auth artifact exposes API-required evidence and stable account identity',async()=>{
  const page={url:()=> 'https://creator.douyin.com/creator-micro/content/upload',title:async()=> '抖音创作者中心',evaluate:async fn=>fn.toString().includes('readStorage')?{localStorage:{},sessionStorage:{}}:'作品发布 上传视频'};
  const context={cookies:async()=>[{name:'sessionid',value:'test-only',domain:'.douyin.com',expires:-1}]};
  const artifact=await new DouyinAdapter().captureCredentialArtifactFromContext(context,page,{accountId:'123',accountName:'Account'});
  assert.equal(artifact.authorizationEvidence.strongCookiePresent,true);
  assert.equal(artifact.authorizationEvidence.workspaceReady,true);
  assert.equal(artifact.platformConfig.accountId,'123');
});

test('borrowed local Chrome assigns large files by CDP path without Playwright transfer',async()=>{
  const {setDouyinInputFile}=await import('../src/adapters/douyin.mjs');
  const calls=[];
  const file={setInputFiles:async()=>{throw new Error('Playwright 50MB transfer must not run');},evaluate:async(fn,args)=>calls.push(['mark',args])};
  const session={send:async(method,params)=>{calls.push([method,params]);if(method==='DOM.getDocument')return {root:{nodeId:1}};if(method==='DOM.querySelector')return {nodeId:42};return {};},detach:async()=>calls.push(['detach'])};
  const page={context:()=>({newCDPSession:async()=>session})};
  await setDouyinInputFile(page,file,'C:/videos/181mb.mp4',true);
  assert.ok(calls.some(([name])=>name==='DOM.setFileInputFiles'));
  const assignment=calls.find(([name])=>name==='DOM.setFileInputFiles')[1];
  assert.deepEqual(assignment.files,['C:\\videos\\181mb.mp4']);
  assert.equal(assignment.nodeId,42);
  assert.equal(calls.at(-1)[0],'detach');
});
test('normal browser still uses Playwright native file upload',async()=>{
  const {setDouyinInputFile}=await import('../src/adapters/douyin.mjs');
  let received;
  await setDouyinInputFile({}, {setInputFiles:async value=>{received=value;}},'video.mp4',false);
  assert.equal(received,'video.mp4');
});

test('short video title uses explicit title or first caption sentence without splitting Unicode',async()=>{
  const {douyinVideoTitle}=await import('../src/adapters/douyin.mjs');
  assert.equal(douyinVideoTitle({caption:'第一句。第二句'}),'第一句');
  assert.equal(douyinVideoTitle({title:'指定标题',caption:'其他文字'}),'指定标题');
  assert.equal(Array.from(douyinVideoTitle({caption:'😀'.repeat(40)})).length,30);
  assert.equal(douyinVideoTitle({caption:''}),'');
});
test('publish settings use observed checkbox labels and avoid toggling selected options off',async()=>{
  const {ensureDouyinImmediatePublic}=await import('../src/adapters/douyin.mjs');
  const clicked=[];const selected=new Map([['公开',false],['立即发布',true],['不同时发布',true]]);
  const page={locator:()=>({filter:({hasText})=>{
    const name=[...selected.keys()].find(name=>hasText.test(name));
    const input={count:async()=>1,isChecked:async()=>selected.get(name)};
    const label={isVisible:async()=>true,locator:()=>input,click:async()=>{clicked.push(name);selected.set(name,true);}};
    return {count:async()=>1,nth:()=>label};
  }})};
  await ensureDouyinImmediatePublic(page);
  assert.deepEqual(clicked,['公开']);
  assert.ok([...selected.values()].every(Boolean));
});

test('account switch after upload prevents native submission',async()=>{
  const {adapter,calls}=fakeAdapter();let checks=0;
  adapter.requireIdentity=async(page,state,timeout,fresh)=>{checks+=1;if(checks===2)assert.equal(fresh,true);return {accountId:checks===1?'123':'456'};};
  await assert.rejects(()=>adapter.publishVideo({videoPath:'video.mp4',expectedAccountId:'123',onProgress:async()=>{}}),/ACCOUNT_MISMATCH/);
  assert.equal(checks,2);assert.ok(!calls.includes('click'));
});

test('create guard refuses cross-platform sync even for immediate public video',async()=>{
  const {isDouyinImmediatePublicVideo}=await import('../src/adapters/douyin.mjs');
  const common={media_type:4,timing:0,visibility_type:0};
  assert.equal(isDouyinImmediatePublicVideo({item:{common,sync:{should_sync:true,sync_to_toutiao:1}}}),false);
  assert.equal(isDouyinImmediatePublicVideo({item:{common,sync:{should_sync:false,sync_to_toutiao:0}}}),true);
});
test('video captions enforce 1000 code points and detect silent editor truncation',async()=>{
  const {validateDouyinCaption,verifyDouyinCaption}=await import('../src/adapters/douyin.mjs');
  assert.equal(validateDouyinCaption('😀'.repeat(1000)).length,2000);
  assert.throws(()=>validateDouyinCaption('字'.repeat(1001)),/CAPTION_TOO_LONG/);
  assert.equal(verifyDouyinCaption('简介\u200b','简介'),true);
  assert.throws(()=>verifyDouyinCaption('截断','截断内容'),/CAPTION_NOT_APPLIED/);
});

test('completed-upload sync switch is explicitly turned off',async()=>{
  const {ensureDouyinImmediatePublic}=await import('../src/adapters/douyin.mjs');let sync=true;
  const labels=new Map(['公开','立即发布'].map(name=>[name,{isVisible:async()=>true,locator:()=>({count:async()=>1,isChecked:async()=>true})}]));
  const syncControl={count:async()=>1,isChecked:async()=>sync};
  const syncContainer={isVisible:async()=>true,locator:selector=>selector==='input[type="checkbox"]'?syncControl:{click:async()=>{sync=false;}}};
  const page={locator:selector=>({filter:({hasText})=>{const item=selector==='label'?labels.get([...labels.keys()].find(name=>hasText.test(name))):syncContainer;return{count:async()=>item?1:0,nth:()=>item};}})};
  await ensureDouyinImmediatePublic(page);assert.equal(sync,false);
});
test('sync control that rebounds after the click is not accepted as disabled',async()=>{
  const {ensureDouyinImmediatePublic}=await import('../src/adapters/douyin.mjs');let reads=0;
  const labels=new Map(['公开','立即发布'].map(name=>[name,{isVisible:async()=>true,locator:()=>({count:async()=>1,isChecked:async()=>true})}]));
  const syncControl={count:async()=>1,isChecked:async()=>++reads!==2};
  const syncContainer={isVisible:async()=>true,locator:selector=>selector==='input[type="checkbox"]'?syncControl:{click:async()=>{}}};
  const page={locator:selector=>({filter:({hasText})=>{const item=selector==='label'?labels.get([...labels.keys()].find(name=>hasText.test(name))):syncContainer;return{count:async()=>item?1:0,nth:()=>item};}})};
  await assert.rejects(()=>ensureDouyinImmediatePublic(page),/SYNC_SETTING_NOT_APPLIED/);
});

test('auth waits for workspace after creator home redirect',async()=>{
 let url='https://creator.douyin.com/creator-micro/home',n=0;
 const page={url:()=>url,title:async()=> '抖音创作者中心',evaluate:async fn=>fn.toString().includes('readStorage')?{localStorage:{},sessionStorage:{}}:'作品发布',goto:async target=>{url=target;n++;}};
 const context={cookies:async()=>[{name:'sessionid',value:'test',domain:'.douyin.com',expires:-1}]};
 const a=await new DouyinAdapter().captureCredentialArtifactFromContext(context,page,{accountId:'123'});
 assert.equal(n,1);assert.equal(a.authorizationEvidence.workspaceReady,true);
});

test('two authorization sessions preserve independent profiles through selected-account publication', async () => {
  const adapter = new DouyinAdapter();
  adapter.captureCredentialArtifactFromContext = async () => ({platformConfig:{accountId:adapter.douyinProfile.accountId}});
  const artifacts=[];
  for (const [sessionId,accountId] of [['session-a','111'],['session-b','222']]) {
    adapter.douyinProfile={accountId};
    artifacts.push(await adapter.collectAuthArtifact({sessionId,keepBrowserOpen:true}));
  }
  assert.notEqual(artifacts[0].profileKey,artifacts[1].profileKey);
  for (const artifact of artifacts) {
    assert.equal(adapter.profileDir({profileRoot:'profiles',profileKey:artifact.profileKey}),adapter.profileDir({profileRoot:'profiles',sessionId:artifact.profileKey}));
  }
  assert.deepEqual(artifacts.map(a=>a.platformConfig.accountId),['111','222']);
});
