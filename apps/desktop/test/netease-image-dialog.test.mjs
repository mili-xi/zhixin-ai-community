import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {confirmNeteaseImageDialog} from '../src/adapters/netease.mjs';

test('NetEase confirms the visible dialog despite an earlier hidden stale dialog', async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(`<div class="ne-modal picture-adder" style="display:none"><button disabled>确定</button></div><div class="ne-modal picture-adder"><button id="active" disabled onclick="window.confirmed=true">确定</button></div>`);
  await page.evaluate(()=>setTimeout(()=>document.querySelector('#active').disabled=false,200));
  await confirmNeteaseImageDialog(page,2000);
  assert.equal(await page.evaluate(()=>window.confirmed),true);
 }finally{await browser.close();}
});
test('NetEase never forces a disabled confirmation and reports its observed state', async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(`<div class="ne-modal picture-adder"><button disabled onclick="window.confirmed=true">确定</button></div>`);
  const events=[];
  await assert.rejects(confirmNeteaseImageDialog(page,30,e=>events.push(e)),/NETEASE_IMAGE_CONFIRM_BUTTON_DISABLED/);
  assert.equal(await page.evaluate(()=>Boolean(window.confirmed)),false);
  assert.equal(events[0].confirmDisabled,true);
 }finally{await browser.close();}
});
