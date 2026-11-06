import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeVideoPublication } from '../src/video-publication.mjs';
async function fixture(t) { const root=await mkdtemp(path.join(tmpdir(),'video-submit-')); t.after(()=>rm(root,{recursive:true,force:true})); return {statePath:path.join(root,'state.json'),commandId:'command-one',input:{videoPath:'test.mp4',expectedAccountId:'account-one'}}; }

test('scheduled acceptance survives callback loss and replay without resubmitting',async t=>{
 const options=await fixture(t);let count=0;const scheduledTimestamp=1793116800;
 options.input={...options.input,publishMode:'scheduled',scheduledTimestamp};
 const adapter={async publishVideo(input){count++;await input.onProgress({stage:'submitting'});return {platformStatus:'scheduled',submissionAccepted:true,itemId:'123',scheduledTimestamp};}};
 const first=await executeVideoPublication({...options,adapter,reportProgress:async()=>{}});
 const replay=await executeVideoPublication({...options,adapter,reportProgress:async()=>{}});
 assert.equal(first.platformStatus,'scheduled');assert.equal(replay.platformStatus,'scheduled');assert.equal(replay.scheduledTimestamp,scheduledTimestamp);assert.equal(count,1);
});
test('scheduled acceptance requires an item ID and the exact requested timestamp',async t=>{
 const options=await fixture(t);options.input={...options.input,publishMode:'scheduled',scheduledTimestamp:1793116800};
 const result=await executeVideoPublication({...options,reportProgress:async()=>{},adapter:{async publishVideo(){return {platformStatus:'scheduled',submissionAccepted:true,itemId:'123',scheduledTimestamp:1793116860};}}});
 assert.equal(result.platformStatus,'submission_unknown');
});
test('awaits durable submitting acknowledgement before adapter can click', async t=>{
 const options=await fixture(t); let acknowledged=false;
 const result=await executeVideoPublication({...options,reportProgress:async e=>{if(e.stage==='submitting') {await new Promise(r=>setTimeout(r,5));acknowledged=true;}},adapter:{async publishVideo(input){await input.onProgress({type:'publish_progress',stage:'submitting'});assert.equal(acknowledged,true);return {platformStatus:'submitted_for_review',itemId:'123',submissionAccepted:true};}}});
 assert.equal(result.platformStatus,'submitted_for_review');
});
test('lost response after submit persists unknown and never submits again on replay',async t=>{
 const options=await fixture(t); let clicks=0;
 const adapter={async publishVideo(input){await input.onProgress({stage:'submitting'});clicks++;throw Error('network timeout cookie=secret');}};
 const first=await executeVideoPublication({...options,adapter,reportProgress:async()=>{}});
 const replay=await executeVideoPublication({...options,adapter,reportProgress:async()=>{}});
 assert.equal(clicks,1);assert.equal(first.platformStatus,'submission_unknown');assert.equal(replay.platformStatus,'submission_unknown');assert.equal(JSON.stringify(first).includes('secret'),false);
});
test('failed durable acknowledgement stops before click and cannot silently resend',async t=>{
 const options=await fixture(t);let clicks=0;
 const result=await executeVideoPublication({...options,reportProgress:async()=>{throw Error('API down')},adapter:{async publishVideo(input){await input.onProgress({stage:'submitting'});clicks++;}}});
 assert.equal(clicks,0);assert.equal(result.platformStatus,'submission_unknown');
});
test('accepted response without item ID cannot be marked published', async t=>{
 const options=await fixture(t);
 const result=await executeVideoPublication({...options,reportProgress:async()=>{},adapter:{async publishVideo(input){await input.onProgress({stage:'submitting'});return {platformStatus:'published',submissionAccepted:true,publicUrl:'https://www.douyin.com/video/1'};}}});
 assert.equal(result.platformStatus,'submission_unknown');
});
test('known successful result is replayed if callback was lost without invoking adapter',async t=>{
 const options=await fixture(t);let count=0;
 const adapter={async publishVideo(input){count++;await input.onProgress({stage:'submitting'});return {platformStatus:'submitted_for_review',itemId:'123',submissionAccepted:true};}};
 await executeVideoPublication({...options,adapter,reportProgress:async()=>{}});
 const replay=await executeVideoPublication({...options,adapter,reportProgress:async()=>{}});
 assert.equal(count,1);assert.equal(replay.itemId,'123');
});
