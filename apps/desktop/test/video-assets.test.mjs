import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadVideoAsset, materializeVideoAssets } from '../src/video-assets.mjs';

const bytes = Buffer.from('test media in two chunks');
const hash = createHash('sha256').update(bytes).digest('hex');
const asset = { id: 'video-asset-one', downloadPath: '/api/video-assets/video-asset-one/content', sizeBytes: bytes.length, sha256: hash };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { apiBaseUrl: 'https://app.example', directory, commandId: 'command-one', headers: { 'x-device-id':'device', 'x-device-token':'secret' }, asset };
}
function response() { return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0,4)); c.enqueue(bytes.subarray(4)); c.close(); } })); }
test('private video download streams and authenticates exact command, verifies bytes and hash', async t => {
  const options = await fixture(t);
  const result = await downloadVideoAsset({ ...options, fetchImpl: async (url, init) => {
    assert.equal(url.toString(), 'https://app.example/api/video-assets/video-asset-one/content?commandId=command-one');
    assert.equal(init.headers['x-device-token'], 'secret');
    assert.equal(init.redirect, 'error');
    const res = response(); res.arrayBuffer = () => { throw Error('must stream'); }; return res;
  }});
  assert.deepEqual(await readFile(result), bytes);
  assert.equal((await readdir(options.directory)).some(x => x.endsWith('.part')), false);
});
test('corrupt video never becomes an available final file', async t => {
  const options = await fixture(t);
  await assert.rejects(downloadVideoAsset({ ...options, asset: {...asset, sha256: '0'.repeat(64)}, fetchImpl: async () => response() }), /HASH_MISMATCH/);
  assert.deepEqual(await readdir(options.directory), []);
});
test('truncated and oversized streams fail before use and remove partial file', async t => {
  const options = await fixture(t);
  for (const size of [bytes.length-1, bytes.length+1]) {
    await assert.rejects(downloadVideoAsset({ ...options, asset: {...asset,sizeBytes:size}, fetchImpl: async () => response() }), /SIZE_MISMATCH/);
    assert.deepEqual(await readdir(options.directory), []);
  }
});
test('credentials cannot follow an arbitrary URL or redirect and unsafe IDs are rejected', async t => {
  const options = await fixture(t);
  for (const downloadPath of ['https://evil.example/api/video-assets/video-asset-one/content','/uploads/file.mp4','/api/video-assets/other/content','/api/video-assets/video-asset-one/content?commandId=other']) {
    await assert.rejects(downloadVideoAsset({...options,asset:{...asset,downloadPath},fetchImpl:()=>assert.fail('network must not run')}), /URL_NOT_ALLOWED/);
  }
  await assert.rejects(downloadVideoAsset({...options, commandId:'../escape'}), /ID_INVALID/);
});
test('video materialization requires trusted descriptors, not arbitrary local video paths', async t => {
  const options = await fixture(t);
  await assert.rejects(materializeVideoAssets({ ...options, statePath: path.join(options.directory,'state.json'), command:{id:'command-one',payload:{videoPath:'C:/private.mp4'}} }), /ASSET_REQUIRED/);
});
