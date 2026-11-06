import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { videoSafeId } from './video-assets.mjs';

const unknown = () => ({ platformStatus:'submission_unknown', submissionAccepted:false, message:'发布提交结果不明，正在等待核实；不会自动重复投稿。' });
async function saveJournal(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary,file); } finally { await unlink(temporary).catch(()=>{}); }
}
function normalizeResult(result, input) {
  const statuses = new Set(['published','submitted_for_review','scheduled','submission_unknown','manual_verification_required','failed','rejected']);
  if (!result || !statuses.has(result.platformStatus)) return unknown();
  if (['published','submitted_for_review','scheduled'].includes(result.platformStatus) && (typeof result.itemId !== 'string' || !/^\d+$/.test(result.itemId) || result.submissionAccepted !== true)) return unknown();
  if (result.platformStatus === 'scheduled' && (!Number.isSafeInteger(result.scheduledTimestamp) || result.scheduledTimestamp<=0 || (input && (input.publishMode!=='scheduled' || input.scheduledTimestamp!==result.scheduledTimestamp)))) return unknown();
  if (result.platformStatus === 'published' && (!result.publicUrl || result.publicVisibilityVerified !== true)) return {...result,platformStatus:'submitted_for_review',publicUrl:''};
  return result;
}
export async function readVideoSubmissionResult(statePath, commandId) {
  const journal=path.join(path.dirname(statePath),'video-submissions',`${videoSafeId(commandId)}.json`);
  let prior;
  try { prior=JSON.parse(await readFile(journal,'utf8')); }
  catch(error) { if(error.code==='ENOENT') return null; throw new Error('VIDEO_SUBMISSION_JOURNAL_UNREADABLE'); }
  if(prior?.result) return normalizeResult(prior.result);
  return prior?.stage==='submitting' ? unknown() : null;
}
// A journal survives a lost callback and process restart. It lives outside the
// age-based media cache: deleting a cached MP4 must not erase submit history.
export async function executeVideoPublication({statePath,commandId,input,adapter,reportProgress,prepareInput}) {
  const directory=path.join(path.dirname(statePath),'video-submissions');
  await mkdir(directory,{recursive:true});
  const journal=path.join(directory,`${videoSafeId(commandId)}.json`);
  const prior=await readVideoSubmissionResult(statePath,commandId);
  if(prior) return prior;
  if(typeof adapter.publishVideo!=='function') throw new Error('VIDEO_PUBLISH_NOT_SUPPORTED');
  let submitting=false;
  try {
    const prepared = prepareInput ? await prepareInput() : {};
    const raw=await adapter.publishVideo({...input,...prepared,onProgress:async event=>{
      if(event.stage==='submitting') {
        if(submitting) throw new Error('VIDEO_DUPLICATE_SUBMIT_BLOCKED');
        await saveJournal(journal,{stage:'submitting',at:new Date().toISOString()});
        submitting=true;
      }
      // Unlike cosmetic article progress, this acknowledgement is a hard gate.
      await reportProgress(event);
    }});
    const result=normalizeResult(raw,input);
    await saveJournal(journal,{stage:'complete',result,at:new Date().toISOString()});
    return result;
  } catch(error) {
    if(!submitting) throw error;
    const result=unknown();
    // The earlier submitting marker is sufficient if this write also fails.
    await saveJournal(journal,{stage:'complete',result,at:new Date().toISOString()}).catch(()=>{});
    return result;
  }
}
