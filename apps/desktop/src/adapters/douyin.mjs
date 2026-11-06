import { resolveProfileKey } from "../session-manager.mjs";
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContentPlatformAdapter, buildContentPlatformAuthArtifact, readConfiguredPlatformPageState } from './content-platform.mjs';
import { collectWebStorage } from './zhihu.mjs';
import { applyDouyinAiCover } from './douyin-ai-cover.mjs';
import { applyDouyinTopics, applyDouyinSmartChapters, verifyDouyinPreparedRequest } from './douyin-enrichment.mjs';

const ORIGIN = 'https://creator.douyin.com';
const UPLOAD = `${ORIGIN}/creator-micro/content/upload`;
const MANAGE = `${ORIGIN}/creator-micro/content/manage`;
const config = {
  platform: 'douyin', loginUrl: UPLOAD, publishBaseUrl: UPLOAD,
  origins: [ORIGIN, 'https://www.douyin.com'], cookieDomains: ['douyin.com'],
  accountLabel: '抖音账号', genericTitle: '抖音创作者中心',
  fields: ['视频', '文案', '封面'], strongCookieNames: ['sessionid', 'sessionid_ss', 'sid_tt'],
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

// JSON.parse rounds 64-bit numeric IDs. Preserve only identifier-valued tokens,
// never rewrite arbitrary string contents or use already-rounded numbers.
export function parseDouyinJson(text) {
  return JSON.parse(String(text).replace(/("(?:aweme_id|item_id|uid|user_id|id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"'));
}
export function douyinAccountProfile(body) {
  if (!body || (body.status_code !== undefined && body.status_code !== 0)) return null;
  if (body.status_code === undefined && body.message !== 'success') return null;
  const user = body.data?.user || body.data?.user_info || body.user_info || body.user || body.data;
  const accountId = id(user?.uid || user?.user_id);
  if (!accountId || !String(user?.nickname || '').trim()) return null;
  return { accountId, accountName: String(user.nickname).trim(), avatar: user.avatar_thumb?.url_list?.[0] || '' };
}
export function douyinAuthorizationEvidence(cookies,profile,pageState) {
  const strongCookiePresent=(Array.isArray(cookies)?cookies:[]).some(cookie=>{
    const domain=String(cookie.domain || '').replace(/^\./,'').toLowerCase();
    return (domain==='douyin.com' || domain.endsWith('.douyin.com'))
      && config.strongCookieNames.includes(String(cookie.name || '').toLowerCase())
      && typeof cookie.value==='string' && cookie.value.length>0
      && (!Number(cookie.expires) || Number(cookie.expires)<0 || Number(cookie.expires)>Date.now()/1000);
  });
  let workspaceUrl=false;
  try {const url=new URL(pageState.url);workspaceUrl=url.origin===ORIGIN && /^\/creator-micro\/(?:content|work-management)(?:\/|$)/.test(url.pathname);} catch {}
  const workspaceReady=Boolean(id(profile?.accountId) && workspaceUrl && /创作者中心|作品发布|内容管理|发布视频/.test(`${pageState.title || ''} ${pageState.text || ''}`));
  return {strongCookiePresent,workspaceReady,currentUrl:String(pageState.url || ''),pageTitle:String(pageState.title || ''),pageText:String(pageState.text || '').slice(0,1000),accountId:profile?.accountId || '',identitySource:'authenticated_user_info',checkedAt:new Date().toISOString()};
}
export function isDouyinImmediatePublicVideo(body) {
  return isDouyinPublicVideo(body,{});
}
export function validateDouyinSchedule(input={},nowMs=Date.now()) {
  const publishMode=input.publishMode||'immediate';
  if(publishMode==='immediate')return {publishMode,scheduledTimestamp:0};
  if(publishMode!=='scheduled')throw new Error('DOUYIN_PUBLISH_MODE_INVALID');
  const iso=String(input.scheduledAt||''),timestamp=input.scheduledTimestamp;
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)||!Number.isInteger(timestamp)||Date.parse(iso)!==timestamp*1000||timestamp%60!==0)throw new Error('DOUYIN_SCHEDULE_INVALID');
  const delta=timestamp*1000-nowMs;
  if(delta<7200000||delta>14*86400000)throw new Error('DOUYIN_SCHEDULE_OUTSIDE_WINDOW');
  return {publishMode,scheduledAt:iso,scheduledTimestamp:timestamp,display:new Date(timestamp*1000+8*3600000).toISOString().slice(0,16).replace('T',' ')};
}
export function isDouyinPublicVideo(body,input={}) {
  const common=body?.item?.common;
  const sync=body?.item?.sync;
  const noSync=sync && [false,0].includes(sync.should_sync) && [false,0].includes(sync.sync_to_toutiao);
  const timing=input.publishMode==='scheduled'?input.scheduledTimestamp:0;
  return Number.isInteger(timing)&&common?.media_type===4 && common.timing===timing && common.visibility_type===0 && Boolean(noSync);
}
export function douyinCreateResult(body,input={}) {
  if(body?.client_blocked) return {platformStatus:'failed',submissionAccepted:false,errorMessage:'DOUYIN_PUBLISH_SETTINGS_MISMATCH',message:'已阻止提交：发布时间、公开范围或准备内容与任务不一致。'};
  if (body?.status_code !== undefined && body.status_code !== 0) {
    return { platformStatus: 'failed', submissionAccepted: false, message: `抖音拒绝提交（${body.status_code}）` };
  }
  const itemId = id(body?.item_id || body?.data?.item_id);
  if (body?.status_code !== 0 || !itemId) return {
    platformStatus: 'submission_unknown', submissionAccepted: false,
    message: '发布请求结果不明，请回查作品；系统不会自动重复提交。',
  };
  if(input.publishMode==='scheduled')return {itemId,platformStatus:'scheduled',submissionAccepted:true,publishMode:'scheduled',scheduledAt:input.scheduledAt,scheduledTimestamp:input.scheduledTimestamp,message:'抖音已受理定时作品，等待计划时间及公开状态回查。'};
  return { itemId, platformStatus: 'submitted_for_review', submissionAccepted: true, message: '抖音已受理，等待公开状态回查。' };
}
export function douyinPublicationResult(itemId, works = [], details = [], input={}) {
  itemId = id(itemId);
  if (!itemId) return { found: false, platformStatus: 'submission_unknown', submissionAccepted: false, message: '没有可核对的作品 ID，请人工检查创作中心。' };
  const work = [...works].reverse().find(row => id(row.aweme_id || row.item_id || row.id) === itemId);
  const detail = [...details].reverse().find(row => id(row.id || row.item_id || row.aweme_id) === itemId);
  const status = work?.status || {};
  const visible = work?.status_value === 102 && status.self_see === false
    && status.is_delete === false && status.is_private === false && status.is_prohibited === false
    && detail?.review?.status === 2 && (detail.visibility === 0 || (detail.visibility && typeof detail.visibility === 'object' && !Array.isArray(detail.visibility) && Object.keys(detail.visibility).length === 0));
  const evidence = { itemId, workMatched: Boolean(work), detailMatched: Boolean(detail),
    statusValue: work?.status_value ?? null, selfSee: status.self_see ?? null,
    reviewStatus: detail?.review?.status ?? null, visibility: detail?.visibility ?? null,
    checkedAt: new Date().toISOString() };
  return {
    itemId, found: visible, platformStatus: visible ? 'published' : 'submitted_for_review',
    ...(input.publishMode==='scheduled'?{publishMode:'scheduled',scheduledTimestamp:input.scheduledTimestamp,scheduledAt:input.scheduledAt}:{}),
    submissionAccepted: true, ...(visible ? { publicUrl: `https://www.douyin.com/video/${itemId}`, publishedUrl: `https://www.douyin.com/video/${itemId}` } : {}),
    evidence, publicationEvidence: {workListVerified: visible, detailVerified: visible}, publicVisibilityVerified: visible, message: visible ? '管理列表和作品详情均确认公开。' : '尚未取得完整公开证据，继续等待回查。',
  };
}
export function douyinVideoReady(state, size) {
  return state.commits.some(commit => commit.videoId && commit.size === size && state.transcodes.some(entry => {
    const info = entry.body.data || entry.body;
    return entry.videoId === commit.videoId && info.encode === 1 && Boolean(info.play_url) && Boolean(info.poster_uri || info.poster_url);
  }));
}
async function readCreatorJson(page, route) {
  // Read-only fallback, not a signature implementation. HTTP/business failures
  // never become publication evidence. Publish POSTs are always page-native.
  const text = await page.evaluate(async route => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(route, {credentials:'include',signal:controller.signal});
      return response.ok ? response.text() : '';
    } finally { clearTimeout(timeout); }
  },route).catch(()=> '');
  try { return text ? parseDouyinJson(text) : null; } catch { return null; }
}
export async function readDouyinWorkList(page,state,itemId) {
  let cursor = '0';
  const cursors = new Set();
  for (let pageIndex=0;pageIndex<5;pageIndex+=1) {
    if(cursors.has(cursor)) break;
    cursors.add(cursor);
    const query = new URLSearchParams({aid:'1128',count:'20',max_cursor:cursor,status:'0',scene:'star_atlas'});
    const body = await readCreatorJson(page,`/janus/douyin/creator/pc/work_list?${query}`);
    if(body?.status_code!==0)break;
    const rows=body.aweme_list || body.data?.aweme_list;
    if(!Array.isArray(rows))break;
    state.works.push(...rows);
    if(rows.some(row=>id(row.aweme_id || row.item_id || row.id)===itemId))break;
    if(!body.has_more || body.max_cursor==null)break;
    cursor=String(body.max_cursor);
  }
}
function watchResponses(page) {
  const state = { profile: null, works: [], details: [], transcodes: [], createBodies: [], commits: [], uploading: false, uploadRequests: new WeakSet(), pending: new Set() };
  const requestListener = request => {
    if (!state.uploading) return;
    try {
      const url = new URL(request.url());
      if (url.hostname === 'vod.bytedanceapi.com' && url.searchParams.get('Action') === 'CommitUploadInner') state.uploadRequests.add(request);
    } catch {}
  };
  page.on('request', requestListener);
  const listen = response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    const vodCommit = url.hostname === 'vod.bytedanceapi.com' && url.searchParams.get('Action') === 'CommitUploadInner'
      && typeof response.request === 'function' && state.uploadRequests.has(response.request());
    if ((!vodCommit && url.origin !== ORIGIN) || !response.ok()) return;
    const pathname = url.pathname;
    if (!vodCommit && !/\/web\/api\/media\/user\/info\/?$|\/work_list\/?$|\/item\/mget\/?$|\/video\/transend\/?$|\/aweme\/create_v2\/?$/.test(pathname)) return;
    const task = (async () => {
      const body = parseDouyinJson(await response.text());
      if (vodCommit) {
        for (const resource of body.Result?.Results || []) {
          if (resource.Vid && resource.VideoMeta?.Size) state.commits.push({videoId:String(resource.Vid),size:Number(resource.VideoMeta.Size)});
        }
        return;
      }
      if (/\/user\/info|\/account\/info/.test(pathname)) state.profile = douyinAccountProfile(body);
      if (body?.status_code !== 0) { if (pathname.includes('/create_v2')) state.createBodies.push(body); return; }
      if (pathname.includes('/work_list')) state.works.push(...(body.aweme_list || body.data?.aweme_list || []));
      if (pathname.includes('/item/mget')) state.details.push(...(body.items || body.data?.items || []));
      if (pathname.includes('/video/transend') && state.uploading) state.transcodes.push({videoId:url.searchParams.get('video_id') || '',body});
      if (pathname.includes('/create_v2')) state.createBodies.push(body);
    })().catch(() => undefined).finally(() => state.pending.delete(task));
    state.pending.add(task);
  };
  page.on('response', listen);
  state.detach = () => { page.off('response', listen); page.off('request', requestListener); };
  return state;
}
async function poll(check, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  do { const value = await check(); if (value) return value; await sleep(300); } while (Date.now() < deadline);
  throw new Error(code);
}
async function uniqueVisible(locator, errorCode) {
  const count = await locator.count();
  const found = [];
  for (let i = 0; i < count; i += 1) if (await locator.nth(i).isVisible()) found.push(locator.nth(i));
  if (found.length !== 1) throw new Error(errorCode);
  return found[0];
}

export async function setDouyinInputFile(page,locator,filePath,borrowedLocalChrome=false) {
  if(!borrowedLocalChrome) {await locator.setInputFiles(filePath);return;}
  // This injection is only for same-machine Chrome. Playwright marks CDP
  // connections remote and buffers >50MiB files; CDP can assign the absolute
  // local path directly, without transferring video bytes over the protocol.
  const attribute=`data-zhixin-upload-${randomUUID()}`;
  let session;
  try {
    await locator.evaluate((element,attribute)=>element.setAttribute(attribute,'1'),attribute);
    session=await page.context().newCDPSession(page);
    const {root}=await session.send('DOM.getDocument',{depth:0,pierce:true});
    const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector:`[${attribute}="1"]`});
    if(!nodeId)throw new Error('DOUYIN_LOCAL_FILE_INPUT_NOT_FOUND');
    await session.send('DOM.setFileInputFiles',{nodeId,files:[path.resolve(filePath)]});
  } finally {
    await locator.evaluate((element,attribute)=>element.removeAttribute(attribute),attribute).catch(()=>{});
    await session?.detach().catch(()=>{});
  }
}
export function validateDouyinCaption(value='') {
  const caption=String(value);
  if(Array.from(caption).length>1000)throw new Error('DOUYIN_CAPTION_TOO_LONG');
  return caption;
}
export function verifyDouyinCaption(actual,expected) {
  const normalize=value=>String(value || '').replace(/\u200b/g,'').replace(/\u00a0/g,' ').replace(/\r\n/g,'\n').trim();
  if(normalize(actual)!==normalize(expected))throw new Error('DOUYIN_CAPTION_NOT_APPLIED');
  return true;
}
export function douyinVideoTitle(input={}) {
  if(Object.hasOwn(input,'title')){
    const title=String(input.title??'').trim();
    if(Array.from(title).length>30)throw new Error('DOUYIN_TITLE_TOO_LONG');
    return title;
  }
  const title=String(input.caption || '').trim().split(/[。！？!?\r\n]/)[0];
  return Array.from(title.replace(/\s+/g,' ').trim()).slice(0,30).join('');
}
export async function setDouyinSchedule(page,input) {
  const schedule=validateDouyinSchedule(input);
  const field=await uniqueVisible(page.getByPlaceholder('日期和时间',{exact:true}),'DOUYIN_SCHEDULE_INPUT_NOT_IDENTIFIED');
  await field.fill(schedule.display);
  await field.press('Tab');
  await sleep(300);
  if(await field.inputValue()!==schedule.display)throw new Error('DOUYIN_SCHEDULE_NOT_APPLIED');
  const selected=page.locator('label').filter({hasText:/^\s*定时发布\s*$/}).locator('input[type="checkbox"]');
  if(!await selected.isChecked())throw new Error('DOUYIN_SCHEDULE_NOT_APPLIED');
  return schedule;
}
export async function ensureDouyinImmediatePublic(page,input={}) {
  // Live DOM 2026-10-26: these are checkbox inputs in visible label elements,
  // not radios. Click a label only when its option is not already selected.
  for(const name of ['公开',input.publishMode==='scheduled'?'定时发布':'立即发布']) {
    const label=await uniqueVisible(page.locator('label').filter({hasText:new RegExp(`^\\s*${name}\\s*$`)}),'DOUYIN_PUBLISH_SETTING_NOT_IDENTIFIED');
    const control=label.locator('input[type="checkbox"]');
    if(await control.count()!==1)throw new Error('DOUYIN_PUBLISH_SETTING_NOT_IDENTIFIED');
    if(!await control.isChecked())await label.click();
    if(!await control.isChecked())throw new Error('DOUYIN_PUBLISH_SETTING_NOT_APPLIED');
  }
  const noSync=page.locator('label').filter({hasText:/^\s*不同时发布\s*$/});
  if(await noSync.count()) {
    const label=await uniqueVisible(noSync,'DOUYIN_SYNC_SETTING_NOT_IDENTIFIED');
    const control=label.locator('input[type="checkbox"]');
    if(await control.count()!==1)throw new Error('DOUYIN_SYNC_SETTING_NOT_IDENTIFIED');
    if(!await control.isChecked())await label.click();
    if(!await control.isChecked())throw new Error('DOUYIN_SYNC_SETTING_NOT_APPLIED');
  } else {
    const container=await uniqueVisible(page.locator('[class^="first-part-"]').filter({hasText:'西瓜视频'}),'DOUYIN_SYNC_SETTING_NOT_IDENTIFIED');
    const control=container.locator('input[type="checkbox"]');
    if(await control.count()!==1)throw new Error('DOUYIN_SYNC_SETTING_NOT_IDENTIFIED');
    if(await control.isChecked())await container.locator('.semi-switch').click();
    if(await control.isChecked())throw new Error('DOUYIN_SYNC_SETTING_NOT_APPLIED');
    // A native checkbox can flip before React commits the controlled value.
    // Require it to remain off after that render, not only immediately on click.
    await sleep(250);
    if(await control.isChecked())throw new Error('DOUYIN_SYNC_SETTING_NOT_APPLIED');
  }
}
export async function setDouyinCovers(page,coverImagePath,borrowedLocalChrome=false) {
  const expectedImage=(await readFile(coverImagePath)).toString('base64');
  const controls=['横封面4:3','竖封面3:4'].map(label=>page.locator('[class^="coverControl-"]').filter({hasText:label}));
  for(const control of controls)if(await control.count()!==1)throw new Error('DOUYIN_COVER_CONTROL_NOT_IDENTIFIED');
  const before=await Promise.all(controls.map(control=>control.locator('img').first().getAttribute('src').catch(()=>'')));
  await controls[0].locator(':scope > div').first().click();
  const dialogs=page.getByRole('dialog').filter({hasText:'上传封面'});
  await dialogs.first().waitFor({state:'visible',timeout:30000});
  const dialog=await uniqueVisible(dialogs,'DOUYIN_COVER_DIALOG_NOT_IDENTIFIED');
  const upload=async()=>{
    // The dialog contains reference-image and cover-image uploaders, each with
    // an additional hidden replacement input. Scope to the observed cover dropzone.
    const image=dialog.locator('.semi-upload').filter({hasText:'点击上传文件或拖拽文件到这里'}).locator('input.semi-upload-hidden-input[type="file"]');
    if(await image.count()!==1)throw new Error('DOUYIN_COVER_INPUT_NOT_IDENTIFIED');
    await setDouyinInputFile(page,image,coverImagePath,borrowedLocalChrome);
    // React clears the file input after its change handler. Verify the exact
    // decoded source image in the editor rather than rereading input.files.
    await poll(()=>dialog.locator('img').evaluateAll((images,base64)=>images.some(image=>image.src.startsWith('data:image/') && image.src.split(',')[1]===base64 && image.complete && image.naturalWidth>0),expectedImage),30000,'DOUYIN_COVER_IMAGE_NOT_LOADED');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  await upload();
  await (await uniqueVisible(dialog.getByRole('button',{name:'设置竖封面',exact:true}),'DOUYIN_VERTICAL_COVER_CONTROL_NOT_IDENTIFIED')).click();
  await dialog.getByText('竖封面预览（3:4）',{exact:true}).waitFor({state:'visible',timeout:30000});
  await upload();
  await (await uniqueVisible(dialog.getByRole('button',{name:'完成',exact:true}),'DOUYIN_COVER_CONFIRM_NOT_IDENTIFIED')).click();
  await dialog.waitFor({state:'hidden',timeout:60000});
  await poll(async()=>{
    for(let index=0;index<controls.length;index+=1){
      const info=await controls[index].locator('img').first().evaluate(image=>({src:image.getAttribute('src'),loaded:image.complete&&image.naturalWidth>0})).catch(()=>null);
      if(!info?.loaded || !info.src || info.src===before[index])return false;
    }
    return true;
  },60000,'DOUYIN_COVER_NOT_APPLIED');
}
async function hasVisibleManualBlocker(page) {
  const dialogs=page.getByRole('dialog').filter({hasText:/声明|验证码|安全验证/});
  for(let index=0;index<await dialogs.count();index+=1)if(await dialogs.nth(index).isVisible())return true;
  return false;
}
export async function waitForDouyinManualVerification(page,input) {
  if(!await hasVisibleManualBlocker(page))return;
  await input.onProgress({type:'manual_verification_required',message:'请在抖音窗口完成验证，完成后将继续发布'});
  await page.bringToFront();
  await poll(async()=>!await hasVisibleManualBlocker(page),Math.min(300000,Number(input.manualVerificationTimeoutMs || 300000)),'DOUYIN_MANUAL_VERIFICATION_TIMEOUT_BEFORE_SUBMISSION');
  await input.onProgress({type:'publish_progress',stage:'preparing',message:'验证已完成，继续准备发布'});
}
export class DouyinAdapter extends ContentPlatformAdapter {
  constructor(options = {}) { super(config, options); this.connectedBrowser = options.connectedBrowser || null; }
  async publishArticle() { throw new Error('DOUYIN_VIDEO_ONLY'); }
  async openWorkspace(input = {}, url = UPLOAD) {
    let context;
    let page;
    if (this.connectedBrowser) {
      const contexts = this.connectedBrowser.contexts();
      if (contexts.length !== 1) throw new Error('DOUYIN_CONNECTED_CONTEXT_AMBIGUOUS');
      const existing = contexts[0];
      page = await existing.newPage();
      // The user's Chrome is borrowed, never owned. No cookie/storage seeding,
      // no context/browser shutdown and no navigation of existing user tabs.
      context = {pages:()=>[page], cookies:(...args)=>existing.cookies(...args), close:()=>page.close()};
    } else {
      context = await this.launchAuthEnvironment(input);
      page = context.pages()[0] || await context.newPage();
    }
    const state = watchResponses(page);
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    catch (error) { state.detach(); await context.close().catch(() => {}); throw error; }
    return {context, page, state};
  }
  async requireIdentity(page, state, timeoutMs = 15000, fresh = false) {
    if(fresh) {
      const profile=douyinAccountProfile(await readCreatorJson(page,'/web/api/media/user/info/'));
      if(!profile)throw new Error('DOUYIN_LOGIN_REQUIRED_OR_IDENTITY_UNAVAILABLE');
      state.profile=profile;
      return profile;
    }
    // Read-only API attempt is not a claim that fetch signs requests. A denied
    // response remains a login/identity failure; publishing always uses the UI.
    if (!state.profile) {
      const body = await readCreatorJson(page,'/web/api/media/user/info/');
      if (body) state.profile = douyinAccountProfile(body);
    }
    return poll(() => state.profile, timeoutMs, 'DOUYIN_LOGIN_REQUIRED_OR_IDENTITY_UNAVAILABLE');
  }
  async detectLoggedIn(input = {}) {
    const workspace = await this.openWorkspace({...input, headless:false});
    this.context = workspace.context; this.page = workspace.page; this.douyinState = workspace.state;
    try { this.douyinProfile = await this.requireIdentity(this.page, workspace.state, Number(input.waitLoginMs || 300000)); return true; }
    catch { workspace.state.detach(); await this.context.close().catch(() => {}); this.context = null; this.page = null; return false; }
  }
  async readAccountProfile() {
    if (!this.douyinProfile?.accountId) throw new Error('DOUYIN_ACCOUNT_ID_UNAVAILABLE');
    return this.douyinProfile;
  }
  async captureCredentialArtifactFromContext(context, page, profile) {
    if (!profile?.accountId) throw new Error('DOUYIN_ACCOUNT_ID_UNAVAILABLE');
    const initial = await readConfiguredPlatformPageState(page);
    let creatorPage = false;
    try { creatorPage = new URL(initial.url).origin === ORIGIN; } catch {}
    if (creatorPage && !douyinAuthorizationEvidence([], profile, initial).workspaceReady) {
      await page.goto(UPLOAD, {waitUntil:'domcontentloaded', timeout:30000});
    }
    const ready = await poll(async () => {
      const cookies = await context.cookies(config.origins);
      const pageState = await readConfiguredPlatformPageState(page);
      const evidence = douyinAuthorizationEvidence(cookies, profile, pageState);
      return evidence.strongCookiePresent && evidence.workspaceReady ? {cookies,evidence} : null;
    }, 15000, 'DOUYIN_AUTH_WORKSPACE_NOT_READY');
    const artifact = buildContentPlatformAuthArtifact(config, {
      cookies:ready.cookies, ...await collectWebStorage(page),
    }, {authorizationEvidence:ready.evidence});
    artifact.platformConfig.accountId = profile.accountId;
    artifact.capabilities = {...artifact.capabilities, canPublishArticle:false, canPublishVideo:true, canScheduleVideo:false};
    return artifact;
  }
  async collectAuthArtifact(input = {}) {
    try {
      const artifact = await this.captureCredentialArtifactFromContext(this.context, this.page, this.douyinProfile);
      artifact.profileKey = resolveProfileKey(input);
      return artifact;
    }
    finally { if (!input.keepBrowserOpen) { this.douyinState?.detach(); await this.context?.close().catch(() => {}); this.context=null;this.page=null; } }
  }
  async validateSession(input = {}) {
    const workspace = await this.openWorkspace(input);
    try {
      const profile = await this.requireIdentity(workspace.page,workspace.state);
      const expected = input.expectedAccountId || input.platformConfig?.accountId;
      if (expected && profile.accountId !== String(expected)) throw new Error('DOUYIN_ACCOUNT_MISMATCH');
      const artifact = await this.captureCredentialArtifactFromContext(workspace.context,workspace.page,profile);
      if (input.onCredentialRefresh) await input.onCredentialRefresh(artifact);
      return {valid:true,platform:'douyin',accountId:profile.accountId,credentialMetadata:artifact.credentialMetadata};
    } finally { workspace.state.detach(); if(!input.keepBrowserOpen)await workspace.context.close().catch(()=>{}); }
  }
  async prepareVideo(page, state, input) {
    const video = await stat(input.videoPath);
    if (!video.isFile() || video.size <= 0) throw new Error('DOUYIN_VIDEO_FILE_INVALID');
    // Semantic selectors are deliberately strict. If the real editor changes or
    // has multiple inputs, stop instead of selecting an arbitrary upload target.
    const file = page.locator('input[type="file"][accept*="video"],input[type="file"][accept*=".mp4"]');
    await file.first().waitFor({state:'attached',timeout:30000});
    if (await file.count() !== 1) throw new Error('DOUYIN_VIDEO_INPUT_NOT_IDENTIFIED');
    state.commits.length = 0; state.transcodes.length = 0; state.uploading = true;
    await setDouyinInputFile(page,file,input.videoPath,Boolean(this.connectedBrowser));
    await poll(() => douyinVideoReady(state,video.size), Number(input.uploadTimeoutMs || 600000), 'DOUYIN_VIDEO_PROCESSING_TIMEOUT');
    await waitForDouyinManualVerification(page,input);
    const title=douyinVideoTitle(input);
    if(title || Object.hasOwn(input,'title')) {
      const titleInput=await uniqueVisible(page.getByPlaceholder('填写作品标题，为作品获得更多流量',{exact:true}),'DOUYIN_TITLE_INPUT_NOT_IDENTIFIED');
      await titleInput.fill(title);
      if(await titleInput.inputValue()!==title)throw new Error('DOUYIN_TITLE_NOT_APPLIED');
    }
    const topics=await applyDouyinTopics(page,validateDouyinCaption(input.caption||''),input);
    const chapters=await applyDouyinSmartChapters(page,input);
    let cover;
    if (input.coverImagePath) {
      await setDouyinCovers(page,input.coverImagePath,Boolean(this.connectedBrowser));
      cover={source:'custom',verified:true};
      for(const [key,label] of [['horizontal','横封面4:3'],['vertical','竖封面3:4']]){
        const size=await page.locator('[class^="coverControl-"]').filter({hasText:label}).locator('img').first().evaluate(e=>({width:e.naturalWidth,height:e.naturalHeight,verified:e.complete&&e.naturalWidth>0}));
        if(!size.verified)throw new Error('DOUYIN_CUSTOM_COVER_NOT_APPLIED');
        cover[key]=size;
      }
    } else cover=await applyDouyinAiCover(page,input);
    state.preparationEvidence={topics,chapters,cover};
    await waitForDouyinManualVerification(page,input);
    state.schedule=validateDouyinSchedule(input);
    await ensureDouyinImmediatePublic(page,state.schedule);
    if(state.schedule.publishMode==='scheduled')await setDouyinSchedule(page,input);
    const publish=await uniqueVisible(page.getByRole('button',{name:'发布',exact:true}), 'DOUYIN_PUBLISH_BUTTON_NOT_IDENTIFIED');
    await publish.waitFor({state:'visible',timeout:30000});
    if(!await publish.isEnabled())throw new Error('DOUYIN_PUBLISH_NOT_READY');
    await input.onProgress?.({type:'publish_progress',stage:'prepared',message:'话题、智能章节和封面已准备完成',preparationEvidence:state.preparationEvidence});
    return state.preparationEvidence;
  }
  async submitVideo(page, state) {
    state.createBodies.length=0;
    const publish=await uniqueVisible(page.getByRole('button',{name:'发布',exact:true}), 'DOUYIN_PUBLISH_BUTTON_NOT_IDENTIFIED');
    const pattern=/^https:\/\/creator\.douyin\.com\/web\/api\/media\/aweme\/create_v2\/?(?:\?|$)/;
    let blocked=false;
    const guard=async route=>{
      let body;
      try { body=route.request().postDataJSON(); } catch {}
      let validTime=true;try{validateDouyinSchedule(state.schedule||{});}catch{validTime=false;}
      if(!validTime||!isDouyinPublicVideo(body,state.schedule)||!verifyDouyinPreparedRequest(body,state.preparationEvidence)) {blocked=true;await route.abort('blockedbyclient');return;}
      await route.continue();
    };
    await page.route(pattern,guard);
    try {
      validateDouyinSchedule(state.schedule||{});
      await publish.click({timeout:15000});
      return await poll(()=>blocked ? {client_blocked:true} : state.createBodies[0],60000,'DOUYIN_SUBMISSION_RESPONSE_UNKNOWN');
    } finally { await page.unroute(pattern,guard).catch(()=>{}); }
  }
  async publishVideo(input = {}) {
    const expectedAccountId=String(input.expectedAccountId || input.platformConfig?.accountId || '');
    if(!id(expectedAccountId))throw new Error('DOUYIN_EXPECTED_ACCOUNT_REQUIRED');
    if(!input.videoPath)throw new Error('DOUYIN_VIDEO_FILE_REQUIRED');
    validateDouyinCaption(input.caption || '');
    douyinVideoTitle(input);
    const schedule=validateDouyinSchedule(input);
    if(typeof input.onProgress!=='function')throw new Error('DOUYIN_DURABLE_PROGRESS_REQUIRED');
    const workspace=await this.openWorkspace(input);
    try {
      const profile=await this.requireIdentity(workspace.page,workspace.state);
      if(profile.accountId!==expectedAccountId)throw new Error('DOUYIN_ACCOUNT_MISMATCH');
      await input.onProgress({type:'publish_progress',stage:'uploading',message:'正在上传视频到抖音'});
      await this.prepareVideo(workspace.page,workspace.state,input);
      const currentProfile=await this.requireIdentity(workspace.page,workspace.state,15000,true);
      if(currentProfile.accountId!==expectedAccountId)throw new Error('DOUYIN_ACCOUNT_MISMATCH');
      validateDouyinSchedule(input);
      // This callback must fail closed when persistence fails. A fire-and-forget
      // progress event cannot protect against a crash after the native click.
      await input.onProgress({type:'publish_progress',stage:'submitting',message:'正在向抖音提交作品'});
      try { return {...douyinCreateResult(await this.submitVideo(workspace.page,workspace.state),schedule),preparationEvidence:workspace.state.preparationEvidence}; }
      catch(error) { if(/^DOUYIN_SCHEDULE_/.test(error.message))throw error;return {...douyinCreateResult(null,schedule),preparationEvidence:workspace.state.preparationEvidence}; }
    } finally { workspace.state.detach?.(); if(!input.keepBrowserOpen)await workspace.context.close().catch(()=>{}); }
  }
  async discoverPublication(input = {}) {
    const itemId=id(input.itemId || input.platformArticleId);
    if(!itemId)return douyinPublicationResult('');
    const workspace=await this.openWorkspace(input,MANAGE);
    try {
      const profile=await this.requireIdentity(workspace.page,workspace.state);
      const expected=String(input.expectedAccountId || input.platformConfig?.accountId || '');
      if(!expected || profile.accountId!==expected)throw new Error('DOUYIN_ACCOUNT_MISMATCH');
      await poll(()=>workspace.state.works.length,15000,'DOUYIN_WORK_LIST_UNAVAILABLE').catch(()=>null);
      if(!workspace.state.works.some(row=>id(row.aweme_id || row.item_id || row.id)===itemId)) await readDouyinWorkList(workspace.page,workspace.state,itemId);
      await workspace.page.goto(`${ORIGIN}/creator-micro/work-management/work-detail/${itemId}`,{waitUntil:'domcontentloaded',timeout:60000});
      await poll(()=>workspace.state.details.some(row=>id(row.id || row.item_id)===itemId),15000,'DOUYIN_DETAIL_UNAVAILABLE').catch(()=>null);
      if(!workspace.state.details.some(row=>id(row.id || row.item_id)===itemId)) {
        const body=await readCreatorJson(workspace.page,`/web/api/creator/item/mget?ids=${encodeURIComponent(itemId)}&fields=metrics,review,play_info`);
        if(body?.status_code===0 && Array.isArray(body.items))workspace.state.details.push(...body.items);
      }
      // Native navigation may paginate/filter the target out of the list; never
      // match by position, caption, or the most recent item as a substitute.
      return douyinPublicationResult(itemId,workspace.state.works,workspace.state.details,input);
    } finally { workspace.state.detach(); if(!input.keepBrowserOpen)await workspace.context.close().catch(()=>{}); }
  }
}
