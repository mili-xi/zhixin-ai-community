import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { completeToutiaoPublishFlow } from '../src/adapters/toutiao.mjs';
for (const scenario of [
 { name: 'no images selects offered no-cover radio', noImages: true, offered: true, selected: true },
 { name: 'images preserve existing cover mode', noImages: false, offered: true, selected: false },
 { name: 'absent mode leaves other controls alone', noImages: true, offered: false, selected: false },
]) {
 test(scenario.name, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
   const page = await browser.newPage();
   await page.setContent(`<button onclick="document.querySelector('section').hidden=false">预览并发布</button><section hidden><label><input type="radio" onclick="document.querySelector('section button').disabled=false">${scenario.offered ? '无封面' : '单图'}</label><button ${scenario.noImages && scenario.offered ? 'disabled' : ''} onclick="window.confirmClicks=(window.confirmClicks||0)+1">确认发布</button></section>`);
   await completeToutiaoPublishFlow(page, 2000, { noImages: scenario.noImages });
   assert.equal(await page.getByRole('radio').isChecked(), scenario.selected);
   assert.equal(await page.evaluate(() => window.confirmClicks), 1);
  } finally { await browser.close(); }
 });
}
