import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export function videoSafeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) throw new Error('VIDEO_ID_INVALID');
  return value;
}
export async function downloadVideoAsset({ apiBaseUrl, directory, commandId, headers, asset, extension = '.mp4', maxBytes = MAX_VIDEO_BYTES, fetchImpl = fetch, timeoutMs = 15 * 60 * 1000, onProgress }) {
  videoSafeId(commandId);
  if (!asset) throw new Error('VIDEO_ASSET_REQUIRED');
  videoSafeId(asset.id);
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > maxBytes || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) throw new Error('VIDEO_ASSET_METADATA_INVALID');
  const base = new URL(apiBaseUrl);
  const url = new URL(asset.downloadPath, base);
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/video-assets/${asset.id}/content`) throw new Error('VIDEO_ASSET_URL_NOT_ALLOWED');
  if (!headers?.['x-device-id'] || !headers?.['x-device-token']) throw new Error('DESKTOP_DEVICE_AUTH_REQUIRED');
  url.searchParams.set('commandId', commandId);
  await mkdir(directory, { recursive: true });
  if (!/^\.(mp4|png|jpg|webp)$/.test(extension)) throw new Error('VIDEO_ASSET_EXTENSION_INVALID');
  const target = path.join(directory, `${asset.id}${extension}`);
  const partial = `${target}.${randomUUID()}.part`;
  let handle, reader;
  try {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) throw new Error(`VIDEO_ASSET_DOWNLOAD_FAILED_HTTP_${response.status}`);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== asset.sizeBytes) throw new Error('VIDEO_ASSET_SIZE_MISMATCH');
    reader = response.body.getReader();
    handle = await open(partial, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0, lastProgress = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.sizeBytes) throw new Error('VIDEO_ASSET_SIZE_MISMATCH');
      hash.update(value);
      // FileHandle.write may write fewer bytes; never silently skip a suffix.
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error('VIDEO_ASSET_WRITE_FAILED');
        offset += bytesWritten;
      }
      if (onProgress && Date.now() - lastProgress > 2000) { await onProgress({ stage: 'downloading', downloadedBytes: size, totalBytes: asset.sizeBytes }); lastProgress = Date.now(); }
    }
    if (size !== asset.sizeBytes) throw new Error('VIDEO_ASSET_SIZE_MISMATCH');
    if (hash.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('VIDEO_ASSET_HASH_MISMATCH');
    await handle.sync(); await handle.close(); handle = null;
    await rename(partial, target);
    return target;
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (handle) await handle.close().catch(() => {});
    await unlink(partial).catch(() => {});
  }
}
export async function materializeVideoAssets(options) {
  const { command, statePath } = options;
  const payload = command.payload || {};
  if (!payload.videoAsset) throw new Error('VIDEO_ASSET_REQUIRED');
  const directory = path.join(path.dirname(statePath), 'publication-assets', videoSafeId(command.id));
  const shared = { ...options, directory, commandId: command.id };
  const videoPath = await downloadVideoAsset({ ...shared, asset: payload.videoAsset });
  const coverImagePath = payload.coverAsset ? await downloadVideoAsset({ ...shared, asset: payload.coverAsset, extension: payload.coverAsset.contentType === 'image/png' ? '.png' : payload.coverAsset.contentType === 'image/webp' ? '.webp' : '.jpg', maxBytes: 10 * 1024 * 1024 }) : '';
  return { ...payload, videoPath, coverImagePath };
}
