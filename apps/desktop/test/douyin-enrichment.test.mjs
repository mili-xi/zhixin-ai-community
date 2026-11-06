import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractDouyinTopics,validateSmartChapters,verifyNativeTopics,verifyDouyinPreparedRequest} from '../src/adapters/douyin-enrichment.mjs';
test('topics preserve order and reject duplicate ambiguous native association',()=>{
 assert.deepEqual(extractDouyinTopics('安装 #监控安装 #布线'),['监控安装','布线']);
 assert.throws(()=>extractDouyinTopics('#监控 #监控'),/DUPLICATE/);
});
test('outbound native evidence rejects plaintext topics and changed chapter content',()=>{
 const proof={topics:{verified:true,resolved:[{name:'监控',id:'9007199254740993'}]},chapters:{verified:true,saved:true,summary:'总结',entries:[{time_stamp:0,title:'引言',detail:''}]}};
 const body={common:{text_extra:'[{"type":1,"hashtag_name":"监控","hashtag_id":9007199254740993}]',challenges:'[9007199254740993]'},item:{chapter:{chapter:JSON.stringify({chapter_type:1,chapter_abstract:'总结',chapter_details:[{timestamp:0,desc:'引言',detail:''}],chapter_tools_info:{chapter_source:2,chapter_recommend_type:1}})}}};
 body.item.common=body.common;delete body.common;
 assert.equal(verifyDouyinPreparedRequest(body,proof),true);
 assert.equal(verifyDouyinPreparedRequest({item:{...body.item,common:{...body.item.common,text_extra:'[]'}}},proof),false);
 assert.equal(verifyDouyinPreparedRequest(body,{...proof,chapters:{...proof.chapters,summary:'篡改'}}),false);
 assert.equal(verifyDouyinPreparedRequest(body,undefined),false);
});
test('plain hashtag text cannot count as native association',()=>{
 assert.throws(()=>verifyNativeTopics(['监控安装'],[],[]),/NOT_APPLIED/);
 assert.deepEqual(verifyNativeTopics(['监控安装'],['#监控安装'],[{cha_name:'监控安装',cid:'1636061413201927'}]),[{name:'监控安装',id:'1636061413201927'}]);
});
test('smart chapters require real nonempty summary and ordered meaningful results',()=>{
 assert.throws(()=>validateSmartChapters({status_code:0,chapter_list:[],chapter_abstract:''}),/UNAVAILABLE/);
 assert.throws(()=>validateSmartChapters({status_code:0,chapter_list:[{time_stamp:10,title:'后'},{time_stamp:0,title:'前'}],chapter_abstract:'总结'}),/INVALID/);
 assert.equal(validateSmartChapters({status_code:0,chapter_list:[{time_stamp:0,title:'引言',detail:''}],chapter_abstract:'总结'}).count,1);
});
test('sanitized real creator create payload matches preparation, with millisecond timestamps',async()=>{
 const body=JSON.parse(await readFile(new URL('./fixtures/douyin-create-enrichment.json',import.meta.url),'utf8'));
 const chapter=JSON.parse(body.item.chapter.chapter),extra=JSON.parse(body.item.common.text_extra);
 const proof={topics:{verified:true,resolved:extra.filter(row=>row.type===1).map(row=>({name:row.hashtag_name,id:String(row.hashtag_id)}))},chapters:{verified:true,saved:true,summary:chapter.chapter_abstract,entries:chapter.chapter_details.map(row=>({time_stamp:row.timestamp,title:row.desc,detail:row.detail}))}};
 assert.equal(verifyDouyinPreparedRequest(body,proof),true);
 proof.chapters.entries[1].time_stamp/=1000;
 assert.equal(verifyDouyinPreparedRequest(body,proof),false);
});
