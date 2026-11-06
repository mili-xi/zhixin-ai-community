import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stat,unlink} from 'node:fs/promises';
import {chromium} from 'playwright';
import {clickReadyToutiaoButton} from '../src/adapters/toutiao.mjs';
test('disabled publish saves a real failure screenshot and observed button state',async()=>{
 const browser=await chromium.launch({headless:true});let screenshot;
 try {const page=await browser.newPage();await page.setContent('<button disabled>确认发布</button>');
 await assert.rejects(clickReadyToutiaoButton(page,'确认发布',40,'TOUTIAO_CONFIRM_PUBLISH_BUTTON_NOT_READY'),asyncError=>{
  assert.equal(asyncError.code,'TOUTIAO_CONFIRM_PUBLISH_BUTTON_DISABLED');assert.equal(asyncError.buttonState.disabled,true);screenshot=asyncError.screenshotPath;return true;
 });assert.ok(screenshot);assert.ok((await stat(screenshot)).size>0);
 }finally{await browser.close();if(screenshot)await unlink(screenshot);}
});
