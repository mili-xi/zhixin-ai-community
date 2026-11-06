import test from 'node:test';import assert from 'node:assert/strict';
import {DouyinAdapter,validateDouyinSchedule,isDouyinPublicVideo,douyinVideoTitle,douyinCreateResult,douyinPublicationResult} from '../src/adapters/douyin.mjs';
const now=Date.parse('2026-10-26T12:00:00+08:00');
const scheduled={publishMode:'scheduled',scheduledAt:'2026-10-27T13:30:00+08:00',scheduledTimestamp:Math.floor(Date.parse('2026-10-27T13:30:00+08:00')/1000)};
test('schedule validates timezone, exact seconds and native 2h..14d window',()=>{
 assert.equal(validateDouyinSchedule(scheduled,now).display,'2026-10-27 13:30');
 for(const delta of [7199,14*86400+1])assert.throws(()=>validateDouyinSchedule({...scheduled,scheduledTimestamp:now/1000+delta,scheduledAt:new Date(now+delta*1000).toISOString()},now));
 assert.throws(()=>validateDouyinSchedule({...scheduled,scheduledAt:'2026-10-27T13:30:00'},now));
 assert.throws(()=>validateDouyinSchedule(scheduled,now+25*3600000),/WINDOW/);
});
test('upload time crossing the native minimum prevents submit and never downgrades to immediate',async()=>{
 const originalNow=Date.now;let current=now;Date.now=()=>current;
 let submitted=false;const adapter=new DouyinAdapter();
 adapter.openWorkspace=async()=>({page:{},state:{},context:{close:async()=>{}}});
 adapter.requireIdentity=async()=>({accountId:'123'});
 adapter.prepareVideo=async()=>{current=now+26*3600000;};
 adapter.submitVideo=async()=>{submitted=true;};
 try{await assert.rejects(()=>adapter.publishVideo({...scheduled,expectedAccountId:'123',videoPath:'fixture.mp4',onProgress:async()=>{}}),/OUTSIDE_WINDOW/);assert.equal(submitted,false);}finally{Date.now=originalNow;}
});
test('future scheduled discovery waits for double public evidence',()=>{
 const result=douyinPublicationResult('7700772236130667816',[],[],{publishMode:'scheduled',scheduledTimestamp:Math.floor(Date.now()/1000)+3600});
 assert.equal(result.platformStatus,'submitted_for_review');assert.notEqual(result.platformStatus,'scheduled');assert.equal(result.found,false);assert.equal(result.publicUrl,undefined);
});
test('explicit blank title never falls back to caption, explicit overlong title fails',()=>{
 assert.equal(douyinVideoTitle({title:'',caption:'简介'}),'');
 assert.throws(()=>douyinVideoTitle({title:'字'.repeat(31)}),/TITLE_TOO_LONG/);
});
test('outbound timing must exactly match requested mode; accepted schedule remains scheduled',()=>{
 const body={item:{common:{media_type:4,visibility_type:0,timing:scheduled.scheduledTimestamp},sync:{should_sync:false,sync_to_toutiao:0}}};
 assert.equal(isDouyinPublicVideo(body,scheduled),true);assert.equal(isDouyinPublicVideo(body,{}),false);
 assert.equal(isDouyinPublicVideo({...body,item:{...body.item,common:{...body.item.common,timing:0}}},scheduled),false);
 const result=douyinCreateResult({status_code:0,item_id:'7700772236130667816'},scheduled);assert.equal(result.platformStatus,'scheduled');assert.equal(result.scheduledTimestamp,scheduled.scheduledTimestamp);
});
