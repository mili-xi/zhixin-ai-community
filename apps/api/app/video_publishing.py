"""Private video assets and durable, device-bound video publication intents.

These records deliberately do not enter article SEO/evidence/indexing workflows.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth.context import current_owner_id
from .database import Record, get_db
from .desktop_identity import require_desktop_agent_device
from .desktop_channels import active_media_account_binding, desktop_device_is_live
from .repositories.workflow_records import sync_workflow_record
from .service import find_record, get_record, list_records, now_stamp, parse_desktop_command_timestamp
from . import app_time
from .config import get_settings

router = APIRouter()
MAX_VIDEO_BYTES = 500 * 1024 * 1024
MAX_COVER_BYTES = 10 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


class VideoUploadLimitMiddleware:
    """Limit bytes before multipart spooling, including chunked requests."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('path') not in {'/api/video-assets/upload', '/api/mcp/video-assets/upload', '/api/mcp/article-assets/upload'}:
            return await self.app(scope, receive, send)
        from starlette.responses import JSONResponse
        maximum = (MAX_COVER_BYTES if scope.get('path') == '/api/mcp/article-assets/upload' else MAX_VIDEO_BYTES) + 2 * 1024 * 1024
        headers = dict(scope.get('headers') or [])
        try:
            length = int(headers.get(b'content-length', b'0'))
        except ValueError:
            return await JSONResponse({'detail':'VIDEO_INVALID_CONTENT_LENGTH'}, status_code=400)(scope,receive,send)
        if length > maximum:
            return await JSONResponse({'detail':'VIDEO_FILE_TOO_LARGE'}, status_code=413)(scope,receive,send)
        count = 0
        async def limited_receive():
            nonlocal count
            message = await receive()
            count += len(message.get('body', b''))
            if count > maximum:
                raise HTTPException(413, 'VIDEO_FILE_TOO_LARGE')
            return message
        return await self.app(scope, limited_receive, send)


def _insert(db: Session, kind: str, data: dict) -> dict:
    data = {**data, 'ownerId': _owner()}
    db.add(Record(id=data['id'], kind=kind, owner_id=_owner(), data=data))
    sync_workflow_record(db, kind, data)
    return data


def private_root() -> Path:
    # Sibling of uploads (not a child): the application's public static mount
    # must never expose an unpublished video.
    root = Path(os.environ.get('ZX_PRIVATE_VIDEO_DIR') or str(Path(get_settings().upload_dir).resolve().parent / 'private-video-assets')).resolve()
    public_root = Path(get_settings().upload_dir).resolve()
    if root == public_root or public_root in root.parents:
        raise HTTPException(503, 'VIDEO_PRIVATE_STORAGE_MISCONFIGURED')
    root.mkdir(parents=True, exist_ok=True)
    return root


def validate_media(path: Path, kind: str) -> dict:
    probe, decoder = shutil.which('ffprobe'), shutil.which('ffmpeg')
    if not probe or not decoder:
        raise HTTPException(503, 'VIDEO_VALIDATOR_UNAVAILABLE')
    try:
        info = subprocess.run([probe, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)], capture_output=True, timeout=25, check=True)
        metadata = json.loads(info.stdout)
        streams = metadata.get('streams') or []
        video = next((s for s in streams if s.get('codec_type') == 'video'), {})
        width, height = int(video.get('width') or 0), int(video.get('height') or 0)
        if width <= 0 or height <= 0 or width > 7680 or height > 7680:
            raise ValueError('dimensions')
        if kind == 'video':
            duration = float(metadata.get('format', {}).get('duration') or 0)
            if not math.isfinite(duration) or duration <= 0 or duration > 1200:
                raise ValueError('duration')
            if 'mp4' not in str(metadata.get('format', {}).get('format_name') or ''):
                raise ValueError('container')
            if video.get('codec_name') not in {'h264', 'hevc'}:
                raise ValueError('codec')
            if any(s.get('codec_type') == 'audio' and s.get('codec_name') not in {'aac', 'mp3'} for s in streams):
                raise ValueError('audio codec')
        else:
            duration = 0
            if video.get('codec_name') not in {'png', 'mjpeg'}:
                raise ValueError('cover codec')
        subprocess.run([decoder, '-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-i', str(path), '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], capture_output=True, timeout=180, check=True)
        return {'duration':duration, 'width':width, 'height':height, 'codec':video.get('codec_name')}
    except (ValueError, KeyError, subprocess.SubprocessError):
        raise HTTPException(422, 'VIDEO_INVALID_MEDIA') from None


def _owner() -> str:
    owner = current_owner_id()
    if not owner:
        raise HTTPException(401, 'AUTHENTICATION_REQUIRED')
    return owner


def _put(db: Session, kind: str, data: dict) -> dict:
    """Flush only; caller commits the whole intent/command/event transaction."""
    owner = _owner()
    data = {**data, 'ownerId':owner}
    row = db.get(Record, data['id'])
    if row is not None:
        if row.owner_id != owner or row.kind != kind:
            raise HTTPException(404, 'VIDEO_RECORD_NOT_FOUND')
        row.data = data
    else:
        db.add(Record(id=data['id'],kind=kind,owner_id=owner,data=data))
    sync_workflow_record(db,kind,data)
    return data


def _public_asset(asset: dict) -> dict:
    return {k:v for k,v in asset.items() if k not in {'path','ownerId'}}


@router.post('/api/video-assets/upload')
async def upload_video_asset(file: UploadFile = File(...), kind: str = Form('video'), db: Session = Depends(get_db)) -> dict:
    _owner()
    filename = Path((file.filename or '').replace('\\','/')).name
    extensions = {'.mp4'} if kind == 'video' else {'.png','.jpg','.jpeg'} if kind == 'cover' else set()
    if Path(filename).suffix.lower() not in extensions:
        raise HTTPException(415,'VIDEO_FILE_TYPE_UNSUPPORTED')
    maximum = MAX_VIDEO_BYTES if kind == 'video' else MAX_COVER_BYTES
    asset_id = 'video-asset-' + uuid4().hex
    root = private_root()
    if file.size is not None and file.size > maximum:
        await file.close()
        raise HTTPException(413,'VIDEO_FILE_TOO_LARGE')
    if shutil.disk_usage(root).free < (file.size or maximum) + 64 * 1024 * 1024:
        await file.close()
        raise HTTPException(507,'VIDEO_STORAGE_FULL')
    temporary = root / (asset_id + '.part')
    target = root / (asset_id + Path(filename).suffix.lower())
    size = 0
    digest = hashlib.sha256()
    try:
        with temporary.open('xb') as destination:
            while chunk := await file.read(CHUNK_BYTES):
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(413,'VIDEO_FILE_TOO_LARGE')
                digest.update(chunk)
                await asyncio.to_thread(destination.write, chunk)
        if not size:
            raise HTTPException(422,'VIDEO_EMPTY_FILE')
        media = await asyncio.to_thread(validate_media, temporary, kind)
        temporary.replace(target)
        asset = _put(db,'videoAssets',{'id':asset_id,'kind':kind,'filename':filename,'path':str(target),'contentType':('video/mp4' if kind=='video' else 'image/png' if media.get('codec')=='png' else 'image/jpeg'),'sizeBytes':size,'sha256':digest.hexdigest(),'media':media,'createdAt':now_stamp()})
        db.commit()
        return _public_asset(asset)
    except BaseException:
        db.rollback()
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()



def normalize_video_publish_options(payload: dict) -> dict:
    title=payload.get('title','')
    if not isinstance(title,str) or len(title)>30:
        raise HTTPException(400,'VIDEO_TITLE_INVALID')
    title=title.strip()
    mode=payload.get('publishMode','immediate')
    if mode not in ('immediate','scheduled'):
        raise HTTPException(400,'VIDEO_PUBLISH_MODE_INVALID')
    scheduled_at=payload.get('scheduledAt')
    if mode=='immediate':
        if scheduled_at not in (None,''):
            raise HTTPException(400,'VIDEO_SCHEDULE_UNEXPECTED')
        return {'title':title,'publishMode':'immediate','scheduledAt':'','scheduledTimestamp':0}
    if not isinstance(scheduled_at,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})',scheduled_at):
        raise HTTPException(400,'VIDEO_SCHEDULE_INVALID')
    try:
        target=datetime.fromisoformat(scheduled_at.replace('Z','+00:00'))
        if target.utcoffset() is None or target.second or target.microsecond:
            raise ValueError('timezone or minute precision')
        target=target.astimezone(app_time.display_timezone())
        timestamp=int(target.timestamp())
    except (ValueError,OverflowError,OSError):
        raise HTTPException(400,'VIDEO_SCHEDULE_INVALID') from None
    return {'title':title,'publishMode':'scheduled','scheduledAt':target.isoformat(timespec='seconds'),'scheduledTimestamp':timestamp}


def validate_video_schedule_window(options: dict) -> None:
    if options['publishMode']=='scheduled':
        remaining=options['scheduledTimestamp']-app_time.now().timestamp()
        if not 2*3600<=remaining<=14*86400:
            raise HTTPException(400,'VIDEO_SCHEDULE_OUT_OF_RANGE')



def scheduled_result_matches_intent(publication: dict, payload: dict) -> bool:
    timestamp=payload.get('scheduledTimestamp')
    return (
        publication.get('publishMode')=='scheduled'
        and payload.get('platformStatus')=='scheduled'
        and type(timestamp) is int
        and timestamp>0
        and timestamp==publication.get('scheduledTimestamp')
    )


def scheduled_publication_is_future(publication: dict) -> bool:
    timestamp=publication.get('scheduledTimestamp')
    return publication.get('publishMode')=='scheduled' and type(timestamp) is int and timestamp>app_time.now().timestamp()



def video_command_supported_by_device(command: dict, device: dict) -> bool:
    payload=command.get('payload') or {}
    is_video=command.get('type')=='publish_video' or (
        command.get('type')=='discover_publication' and payload.get('videoPublicationId')
    )
    if not is_video:
        return True
    capabilities=device.get('capabilities')
    if not isinstance(capabilities,dict) or capabilities.get('publish_video_v1') is not True:
        return False
    return payload.get('publishMode')!='scheduled' or capabilities.get('publish_video_schedule_v1') is True


def _device(db: Session, account: dict, *, require_schedule: bool = False) -> dict:
    from .main import media_account_is_authorized
    if account.get('platform') != 'douyin':
        raise HTTPException(400,'VIDEO_PLATFORM_UNSUPPORTED')
    if not media_account_is_authorized(db,account):
        raise HTTPException(400,'MEDIA_ACCOUNT_NOT_AUTHORIZED')
    if not str((account.get('platformConfig') or {}).get('accountId') or account.get('platformAccountId') or account.get('accountId') or ''):
        raise HTTPException(409,'DOUYIN_ACCOUNT_ID_REQUIRED')
    binding = active_media_account_binding(db,account['id'])
    if not binding:
        raise HTTPException(400,'MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED')
    # Never silently move a video to a different machine/profile.
    device = find_record(db,'desktopDevices',str(binding.get('deviceId') or ''))
    if not device or device.get('boundOwnerId') != _owner():
        raise HTTPException(403,'DESKTOP_DEVICE_OWNER_MISMATCH')
    if not desktop_device_is_live(device, now=app_time.now()):
        raise HTTPException(409,'DESKTOP_DEVICE_OFFLINE')
    if not isinstance(device.get('capabilities'),dict) or device['capabilities'].get('publish_video_v1') is not True:
        raise HTTPException(409,'DESKTOP_VIDEO_UPGRADE_REQUIRED')
    if require_schedule and device['capabilities'].get('publish_video_schedule_v1') is not True:
        raise HTTPException(409,'DESKTOP_VIDEO_SCHEDULE_UPGRADE_REQUIRED')
    return device


@router.get('/api/video-publications/capabilities')
def video_capabilities(db: Session = Depends(get_db)) -> dict:
    accounts=[]
    for account in list_records(db,'mediaAccounts'):
        if account.get('platform') != 'douyin': continue
        try:
            device=_device(db,account)
            accounts.append({'mediaAccountId':account['id'],'deviceId':device['id'],'ready':True,'supportsScheduled':device['capabilities'].get('publish_video_schedule_v1') is True,'error':''})
        except HTTPException as exc:
            accounts.append({'mediaAccountId':account['id'],'deviceId':'','ready':False,'supportsScheduled':False,'error':exc.detail})
    return {'maxVideoBytes':MAX_VIDEO_BYTES,'maxCoverBytes':MAX_COVER_BYTES,'accounts':accounts}


def _asset_ref(asset: dict, command_id: str) -> dict:
    return {'id':asset['id'],'downloadPath':f"/api/video-assets/{asset['id']}/content",'sizeBytes':asset['sizeBytes'],'sha256':asset['sha256'],'contentType':asset.get('contentType','video/mp4')}


def _locked_asset(db: Session, asset_id: str) -> dict:
    row=db.scalar(select(Record).where(Record.id==asset_id,Record.kind=='videoAssets',Record.owner_id==_owner()).with_for_update())
    if not row: raise HTTPException(404,'VIDEOASSETS_NOT_FOUND')
    return dict(row.data)


@router.post('/api/video-publications')
async def create_video_publication(request: Request, db: Session = Depends(get_db)) -> dict:
    return create_video_publication_payload(await request.json(),db)


def create_video_publication_payload(payload: dict, db: Session) -> dict:
    if not isinstance(payload,dict): raise HTTPException(400,'VIDEO_REQUEST_INVALID')
    asset=_locked_asset(db,str(payload.get('assetId') or ''))
    if asset.get('kind') != 'video': raise HTTPException(400,'VIDEO_ASSET_REQUIRED')
    account=get_record(db,'mediaAccounts',str(payload.get('mediaAccountId') or ''))
    options=normalize_video_publish_options(payload)
    caption=str(payload.get('caption') or '').strip()
    key=str(payload.get('idempotencyKey') or '').strip()
    if not key or len(key)>128 or not caption or len(caption)>1000:
        raise HTTPException(400,'VIDEO_CAPTION_OR_INTENT_INVALID')
    cover=_locked_asset(db,str(payload['coverAssetId'])) if payload.get('coverAssetId') else None
    if cover and cover.get('kind') != 'cover': raise HTTPException(400,'VIDEO_COVER_ASSET_REQUIRED')
    # Content identity is stronger than a browser-generated key: reloading the
    # page cannot create a second post of this asset on this account.
    identity=hashlib.sha256(f"{_owner()}:{account['id']}:{asset['sha256']}".encode()).hexdigest()
    publication_id='video-publication-'+identity[:40]
    fingerprint=hashlib.sha256(json.dumps([caption,cover and cover['sha256'],options['title'],options['publishMode'],options['scheduledTimestamp']],ensure_ascii=False).encode()).hexdigest()
    accepted_fingerprints={fingerprint}
    if options['title']=='' and options['publishMode']=='immediate':
        accepted_fingerprints.add(hashlib.sha256(json.dumps([caption,cover and cover['sha256']],ensure_ascii=False).encode()).hexdigest())
    key_id='video-intent-'+hashlib.sha256(f'{_owner()}:{key}'.encode()).hexdigest()[:40]
    reserved=find_record(db,'videoIntentKeys',key_id)
    if reserved and reserved.get('publicationId') != publication_id: raise HTTPException(409,'VIDEO_IDEMPOTENCY_CONFLICT')
    existing=find_record(db,'videoPublications',publication_id)
    retry = bool(existing and existing.get('status')=='failed' and not existing.get('submittedAt') and not existing.get('itemId') and not reserved)
    if existing and not retry:
        if existing.get('inputFingerprint') not in accepted_fingerprints: raise HTTPException(409,'VIDEO_ALREADY_HAS_PUBLICATION')
        return {'publication':existing,'command':get_record(db,'desktopCommands',existing['commandId']),'deduplicated':True}
    attempt=int((existing or {}).get('attempt') or 1)+1 if retry else 1
    validate_video_schedule_window(options)
    device=_device(db,account,require_schedule=options['publishMode']=='scheduled')
    expected_account_id=str((account.get('platformConfig') or {}).get('accountId') or account.get('platformAccountId') or account.get('accountId') or '')
    if not expected_account_id: raise HTTPException(409,'DOUYIN_ACCOUNT_ID_REQUIRED')
    command_id='video-command-'+identity[:40]+('-'+str(attempt) if attempt>1 else '')
    timestamp=now_stamp()
    command={'id':command_id,'deviceId':device['id'],'type':'publish_video','mediaAccountId':account['id'],'status':'queued','result':{},'errorMessage':'','createdAt':timestamp,'updatedAt':timestamp,'payload':{'platform':'douyin','videoPublicationId':publication_id,'videoAsset':_asset_ref(asset,command_id),'caption':caption,'profileKey':account.get('profileKey') or account['id'],'expectedAccountId':str((account.get('platformConfig') or {}).get('accountId') or account.get('platformAccountId') or account.get('accountId') or ''), 'headless':False,'allowForeground':True}}
    command['payload'].update(options)
    if cover: command['payload']['coverAsset']=_asset_ref(cover,command_id)
    publication={'id':publication_id,'attempt':attempt,'previousCommandId':existing['commandId'] if retry else '', 'assetId':asset['id'],'coverAssetId':cover['id'] if cover else '', 'mediaAccountId':account['id'],'deviceId':device['id'],'commandId':command_id,'caption':caption,'inputFingerprint':fingerprint,'idempotencyKey':key,'status':'queued','platformStatus':'queued','stage':'queued','itemId':'','publicUrl':'','message':'','errorMessage':'','createdAt':timestamp,'updatedAt':timestamp}
    publication.update(options)
    try:
        _insert(db,'videoIntentKeys',{'id':key_id,'publicationId':publication_id})
        (_put if retry else _insert)(db,'videoPublications',publication)
        _insert(db,'desktopCommands',command)
        db.commit()
    except IntegrityError:
        db.rollback()
        reserved=find_record(db,'videoIntentKeys',key_id)
        if reserved and reserved.get('publicationId') != publication_id: raise HTTPException(409,'VIDEO_IDEMPOTENCY_CONFLICT')
        existing=get_record(db,'videoPublications',publication_id)
        if existing.get('inputFingerprint') not in accepted_fingerprints: raise HTTPException(409,'VIDEO_ALREADY_HAS_PUBLICATION')
        return {'publication':existing,'command':get_record(db,'desktopCommands',existing['commandId']),'deduplicated':True}
    return {'publication':publication,'command':command,'deduplicated':False}



@router.post('/api/video-publications/{publication_id}/retry')
async def retry_video(publication_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    publication=get_record(db,'videoPublications',publication_id)
    body=await request.json()
    if not isinstance(body,dict): raise HTTPException(400,'VIDEO_REQUEST_INVALID')
    # Replayed retry requests may observe a newly queued attempt; allow the
    # exact key to read that result, never to initiate another attempt.
    same_key=body.get('idempotencyKey')==publication.get('idempotencyKey')
    if not same_key and (publication.get('status')!='failed' or publication.get('submittedAt') or publication.get('itemId')):
        raise HTTPException(409,'VIDEO_RETRY_NOT_SAFE')
    return create_video_publication_payload({'assetId':publication['assetId'],'mediaAccountId':publication['mediaAccountId'],'caption':publication['caption'],'title':publication.get('title',''),'publishMode':publication.get('publishMode','immediate'),'scheduledAt':publication.get('scheduledAt',''),'coverAssetId':publication.get('coverAssetId'),'idempotencyKey':body.get('idempotencyKey')},db)


@router.get('/api/video-publications')
def video_publications(db: Session = Depends(get_db)) -> list[dict]:
    return list(reversed(list_records(db,'videoPublications')))


@router.get('/api/video-assets/{asset_id}/content')
def download_video_asset(asset_id: str, commandId: str, request: Request, db: Session = Depends(get_db)):
    device=require_desktop_agent_device(db,str(request.headers.get('x-device-id') or ''),str(request.headers.get('x-device-token') or ''))
    command=get_record(db,'desktopCommands',commandId)
    if command.get('deviceId') != device['id'] or device.get('boundOwnerId') != _owner() or command.get('type') != 'publish_video':
        raise HTTPException(403,'VIDEO_ASSET_COMMAND_MISMATCH')
    if command.get('status') not in {'queued','running'}:
        raise HTTPException(409,'VIDEO_ASSET_COMMAND_INACTIVE')
    refs=command.get('payload') or {}
    if not any((refs.get(k) or {}).get('id') == asset_id for k in ('videoAsset','coverAsset')):
        raise HTTPException(403,'VIDEO_ASSET_COMMAND_MISMATCH')
    asset=get_record(db,'videoAssets',asset_id)
    path=Path(asset['path']).resolve()
    if path.parent != private_root() or not path.is_file(): raise HTTPException(404,'VIDEO_ASSET_FILE_MISSING')
    return FileResponse(path,media_type='application/octet-stream',filename=asset['filename'],headers={'Cache-Control':'no-store','X-Content-SHA256':asset['sha256']})


def queue_video_discovery(db: Session, publication: dict) -> dict:
    row=db.scalar(select(Record).where(Record.id==publication['id'],Record.kind=='videoPublications',Record.owner_id==_owner()).with_for_update().execution_options(populate_existing=True))
    if not row: raise HTTPException(404,'VIDEO_PUBLICATION_NOT_FOUND')
    publication=dict(row.data)
    if not publication.get('itemId'): raise HTTPException(409,'VIDEO_ITEM_ID_UNCONFIRMED')
    if publication.get('status') == 'published':
        return {'publication':publication,'command':None,'deduplicated':True}
    previous=find_record(db,'desktopCommands',str(publication.get('discoveryCommandId') or ''))
    if previous and previous.get('status') in {'queued','running'}:
        stamp=parse_desktop_command_timestamp(previous.get('updatedAt')) or parse_desktop_command_timestamp(previous.get('createdAt'))
        if stamp is None or (app_time.now()-stamp).total_seconds()>=3600:
            _put(db,'desktopCommands',{**previous,'status':'failed','errorMessage':'VIDEO_DISCOVERY_EXECUTION_LOST','updatedAt':now_stamp()})
        else:
            return {'publication':publication,'command':previous,'deduplicated':True}
    account=get_record(db,'mediaAccounts',publication['mediaAccountId']); device=_device(db,account,require_schedule=publication.get('publishMode')=='scheduled')
    command={'id':'video-discovery-'+uuid4().hex,'deviceId':device['id'],'type':'discover_publication','mediaAccountId':account['id'],'status':'queued','result':{},'errorMessage':'','createdAt':now_stamp(),'updatedAt':now_stamp(),'payload':{'platform':'douyin','videoPublicationId':publication['id'],'itemId':publication['itemId'],'platformArticleId':publication['itemId'],'profileKey':account.get('profileKey') or account['id'],'expectedAccountId':str((account.get('platformConfig') or {}).get('accountId') or account.get('platformAccountId') or account.get('accountId') or ''), 'headless':False,'allowForeground':True}}
    command['payload'].update({key:publication.get(key,default) for key,default in (('title',''),('publishMode','immediate'),('scheduledAt',''),('scheduledTimestamp',0))})
    publication={**publication,'discoveryCommandId':command['id'],'nextDiscoveryAt':(app_time.now()+timedelta(minutes=5)).isoformat()}
    _put(db,'desktopCommands',command); _put(db,'videoPublications',publication); db.commit()
    return {'publication':publication,'command':command,'deduplicated':False}


@router.post('/api/video-publications/{publication_id}/discover')
def discover_video(publication_id: str, db: Session = Depends(get_db)) -> dict:
    return queue_video_discovery(db,get_record(db,'videoPublications',publication_id))



def sanitized_discovery_evidence(payload: dict, checked_at: str) -> dict:
    """Retain only status facts, never raw platform responses or credentials."""
    raw=payload.get('publicationEvidence')
    raw=raw if isinstance(raw,dict) else {}
    public_evidence={
        'workListVerified':raw.get('workListVerified') is True,
        'detailVerified':raw.get('detailVerified') is True,
        'checkedAt':checked_at,
    }
    raw_state=payload.get('evidence')
    state={'checkedAt':checked_at}
    if isinstance(raw_state,dict):
        observed_id=str(raw_state.get('itemId') or '')
        if re.fullmatch(r'\d{1,30}',observed_id): state['itemId']=observed_id
        for key in ('statusValue','reviewStatus','visibility'):
            value=raw_state.get(key)
            if value is None or type(value) is int:
                state[key]=value
        for key in ('selfSee','workMatched','detailMatched'):
            value=raw_state.get(key)
            if value is None or type(value) is bool:
                state[key]=value
    return {'publicationEvidence':public_evidence,'evidence':state}



def sanitized_preparation_evidence(value: object) -> dict | None:
    """Bounded preparation facts, independent of publication/public visibility.

    Unknown keys never enter storage. A malformed known section discards this
    update rather than overwriting previously recorded, valid preparation.
    """
    if not isinstance(value,dict):
        return None
    clean={}

    def topic_name(name: object) -> str:
        if not isinstance(name,str) or not name.strip() or len(name)>100:
            raise ValueError('topic name')
        if '://' in name or any(ord(character)<32 for character in name):
            raise ValueError('topic name')
        return name

    def flag(section: dict) -> bool:
        if type(section.get('verified')) is not bool:
            raise ValueError('verified')
        return section['verified']

    def dimensions(section: object) -> dict:
        if not isinstance(section,dict):
            raise ValueError('dimensions')
        if any(type(section.get(key)) is not int or not 1<=section[key]<=16384 for key in ('width','height')):
            raise ValueError('dimensions')
        return {'width':section['width'],'height':section['height'],'verified':flag(section)}

    try:
        if 'topics' in value:
            topics=value['topics']
            if not isinstance(topics,dict): raise ValueError('topics')
            requested,resolved=topics.get('requested'),topics.get('resolved')
            if not isinstance(requested,list) or not isinstance(resolved,list) or len(requested)>20 or len(resolved)>20:
                raise ValueError('topics')
            requested=[topic_name(name) for name in requested]
            selected=[]
            for item in resolved:
                if not isinstance(item,dict) or not isinstance(item.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',item['id']):
                    raise ValueError('topic id')
                selected.append({'name':topic_name(item.get('name')),'id':item['id']})
            clean['topics']={'requested':requested,'resolved':selected,'verified':flag(topics)}
        if 'chapters' in value:
            chapters=value['chapters']
            if not isinstance(chapters,dict) or chapters.get('source')!='platform_smart' or type(chapters.get('count')) is not int or not 0<=chapters['count']<=1000:
                raise ValueError('chapters')
            clean['chapters']={'source':'platform_smart','count':chapters['count'],'verified':flag(chapters)}
        if 'cover' in value:
            cover=value['cover']
            if not isinstance(cover,dict) or cover.get('source') not in {'platform_ai','custom'}:
                raise ValueError('cover')
            clean['cover']={'source':cover['source'],'verified':flag(cover),'horizontal':dimensions(cover.get('horizontal')),'vertical':dimensions(cover.get('vertical'))}
    except (ValueError,TypeError):
        return None
    return clean or None


def handle_video_event(db: Session, command: dict, event_type: str, payload: dict) -> dict:
    publication_id=(command.get('payload') or {}).get('videoPublicationId')
    # Serialize status transitions; a late progress event must not overwrite a
    # terminal result, and submission evidence must commit before click.
    row=db.scalar(select(Record).where(Record.id==publication_id,Record.kind=='videoPublications',Record.owner_id==_owner()).with_for_update().execution_options(populate_existing=True))
    if not row: raise HTTPException(404,'VIDEO_PUBLICATION_NOT_FOUND')
    publication=dict(row.data)
    command=get_record(db,'desktopCommands',command['id'])
    discovery=command.get('type')=='discover_publication'
    if command['id'] != publication.get('discoveryCommandId' if discovery else 'commandId'):
        raise HTTPException(409,'VIDEO_PUBLICATION_COMMAND_MISMATCH')
    allowed={'accepted','running','publication_discovery_succeeded','publication_discovery_failed'} if discovery else {'accepted','running','publish_started','publish_progress','manual_verification_required','publish_succeeded','publish_failed'}
    if event_type not in allowed: raise HTTPException(400,'DESKTOP_COMMAND_EVENT_INVALID')
    terminal=event_type.endswith('_succeeded') or event_type.endswith('_failed')
    if command.get('status') in {'succeeded','failed','canceled'}:
        if not terminal: raise HTTPException(409,'DESKTOP_COMMAND_ALREADY_TERMINAL')
        return {'command':command,'publication':publication,'mediaOrder':None}
    item_id=str(payload.get('itemId') or payload.get('platformArticleId') or '')
    if item_id and not re.fullmatch(r'\d{1,30}',item_id): raise HTTPException(400,'VIDEO_ITEM_ID_INVALID')
    if discovery and item_id and item_id != str(publication.get('itemId')):
        raise HTTPException(409,'VIDEO_DISCOVERY_ITEM_MISMATCH')
    stage=str(payload.get('stage') or '')[:80]
    status=publication.get('status','running')
    if not discovery:
        if event_type=='publish_progress' and stage=='submitting':
            status='submitting'
        elif event_type=='manual_verification_required': status='manual_verification_required'
        elif event_type=='publish_failed':
            status='submission_unknown' if publication.get('submittedAt') or item_id else 'failed'
        elif event_type=='publish_succeeded':
            status='submission_unknown'
            if item_id and payload.get('submissionAccepted') is True:
                if publication.get('publishMode')=='scheduled':
                    if scheduled_result_matches_intent(publication,payload):
                        status='scheduled'
                elif payload.get('platformStatus')!='scheduled':
                    status='submitted_for_review'
        elif not publication.get('submittedAt'): status='running'
    discovery_evidence=sanitized_discovery_evidence(payload,now_stamp()) if discovery and terminal else None
    if discovery and terminal:
        status=publication.get('status')
        if event_type.endswith('_succeeded'):
            # Require exact ID, evidence from both creator endpoints, and a
            # canonical public link. The adapter cannot promote on HTTP 200.
            expected=f"https://www.douyin.com/video/{publication.get('itemId')}"
            evidence=discovery_evidence['publicationEvidence']
            if item_id and payload.get('found') is True and payload.get('platformStatus')=='published' and payload.get('publicUrl')==expected and evidence.get('workListVerified') is True and evidence.get('detailVerified') is True:
                status='published'
            elif payload.get('platformStatus')=='rejected' or (payload.get('platformStatus')=='failed' and not scheduled_publication_is_future(publication)): status='failed'
    next_status='succeeded' if event_type.endswith('_succeeded') else 'failed' if event_type.endswith('_failed') else 'running'
    publication={**publication,'status':status,'platformStatus':status,'stage':stage or publication.get('stage',''),'updatedAt':now_stamp(),'message':str(payload.get('message') or '')[:500],'errorMessage':str(payload.get('errorMessage') or '')[:500]}
    if status=='submitting': publication['submittedAt']=publication.get('submittedAt') or now_stamp()
    if item_id: publication['itemId']=item_id
    if status=='published': publication['publicUrl']=payload['publicUrl']
    result={**(command.get('result') or {}),**{k:payload[k] for k in ('itemId','platformArticleId','platformStatus','submissionAccepted','publicUrl','message','errorMessage','stage') if k in payload}}
    if type(payload.get('scheduledTimestamp')) is int and 0<=payload['scheduledTimestamp']<=253402300799:
        result['scheduledTimestamp']=payload['scheduledTimestamp']
    preparation_evidence=sanitized_preparation_evidence(payload.get('preparationEvidence'))
    if preparation_evidence is not None:
        result['preparationEvidence']=preparation_evidence
        publication['preparationEvidence']=preparation_evidence
    if discovery_evidence is not None:
        result.update(discovery_evidence)
        publication.update(discovery_evidence)
    command={**command,'status':next_status,'result':result,'errorMessage':str(payload.get('errorMessage') or '')[:500],'updatedAt':now_stamp()}
    _put(db,'videoPublications',publication); _put(db,'desktopCommands',command)
    event={'id':'video-event-'+uuid4().hex,'deviceId':command['deviceId'],'commandId':command['id'],'type':event_type,'payload':result,'createdAt':now_stamp()}
    _put(db,'desktopEvents',event); db.commit()
    return {'command':command,'publication':publication,'event':event,'mediaOrder':None}


def enqueue_video_discoveries(db: Session) -> int:
    count=0
    for publication in list_records(db,'videoPublications'):
        if publication.get('status') not in {'submitted_for_review','submission_unknown','submitting','running','scheduled'}: continue
        if publication.get('status')=='scheduled' and scheduled_publication_is_future(publication): continue
        # A lost desktop never causes a repost. Surface the uncertain state.
        command=find_record(db,'desktopCommands',publication.get('commandId',''))
        if command and command.get('status')=='running':
            updated=parse_desktop_command_timestamp(command.get('updatedAt'))
            if updated and (app_time.now()-updated).total_seconds()>7200:
                handle_video_event(db,command,'publish_failed',{'errorMessage':'VIDEO_EXECUTION_LOST'})
                publication=get_record(db,'videoPublications',publication['id'])
        if not publication.get('itemId'): continue
        due=parse_desktop_command_timestamp(publication.get('nextDiscoveryAt'))
        if due and due>app_time.now(): continue
        try:
            result=queue_video_discovery(db,publication)
            count+=not result['deduplicated']
        except HTTPException:
            db.rollback()
    return count


def cleanup_unused_video_assets(db: Session) -> int:
    """Seven-day orphan cleanup; every publication reference is retained.

    This intentionally retains published/uncertain assets too: automatic
    retention of a referenced asset is safer than deleting audit evidence.
    """
    count=0
    for candidate in list_records(db,'videoAssets'):
        created=parse_desktop_command_timestamp(candidate.get('createdAt'))
        if not created or (app_time.now()-created).total_seconds()<7*86400: continue
        row=db.scalar(select(Record).where(Record.id==candidate['id'],Record.kind=='videoAssets',Record.owner_id==_owner()).with_for_update())
        if not row: continue
        referenced=any(candidate['id'] in {pub.get('assetId'),pub.get('coverAssetId')} for pub in list_records(db,'videoPublications'))
        if referenced:
            db.rollback()
            continue
        path=Path(row.data['path']).resolve()
        if path.parent != private_root():
            db.rollback()
            continue
        path.unlink(missing_ok=True)
        db.delete(row)
        db.commit()
        count+=1
    return count
