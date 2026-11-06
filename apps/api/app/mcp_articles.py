"""Owned finished articles over MCP; durable claims surround legacy queue commits."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy import select, exists, and_, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased, Session
from starlette.concurrency import run_in_threadpool

from .auth.context import actor_scope, current_owner_id
from .config import get_settings
from .database import Record, get_db
from .models.workflows import TaskJob
from .desktop_channels import active_media_account_binding, desktop_device_is_live
from .illustrated_content import build_content_blocks
from .mcp_access import ARTICLE_WRITE, ARTICLE_UPLOAD_PATH, authenticate_request
from .service import (
    default_article, find_record, get_record, media_account_has_active_credentials,
    now_stamp, queue_article_media_publish_command, queue_media_publication_discovery, resolve_media_account,
)
from . import video_publishing as video

router = APIRouter()
PLATFORMS = {'zhihu':'知乎','baijiahao':'百家号','sohu':'搜狐号','csdn':'CSDN','netease':'网易号','penguin':'企鹅号','toutiao':'头条号','jianshu':'简书'}
INTENTS = 'mcpArticlePublications'
KEYS = 'mcpArticlePublishKeys'
MAX_IMAGE_BYTES = 10*1024*1024
IMAGE_RE = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')
HTML_RE = re.compile(r'<\s*/?\s*[a-zA-Z][^>]*>')
ASSET_FIELDS = ('id','filename','contentType','url','altText','sizeBytes','createdAt')
ARTICLE_FIELDS = ('id','title','summary','contentMarkdown','tags','keywords','sections','contentBlocks','coverImage','inlineImages','status','createdAt','updatedAt')
RECHECK_LOCKS = [threading.RLock() for _ in range(64)]


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def project(data, fields):
    return {k:data[k] for k in fields if k in data}


def public_article(data):
    result=project(data,ARTICLE_FIELDS)
    result['coverImage']=project(data.get('coverImage') or {},('assetId','url','altText','purpose'))
    result['inlineImages']=[project(x,('assetId','url','altText','sectionId','purpose')) for x in data.get('inlineImages') or []]
    result['contentBlocks']=[project(x,('type','text','title','content','sectionId','assetId','url','altText')) for x in data.get('contentBlocks') or []]
    result['sections']=[project(x,('id','title','content')) for x in data.get('sections') or []]
    return result


def _row(db,kind,rid):
    return db.scalar(select(Record).where(Record.id==rid,Record.kind==kind,Record.owner_id==current_owner_id()))


def _insert(db,kind,rid,data):
    db.add(Record(id=rid,kind=kind,owner_id=current_owner_id(),data={'id':rid,**data}))
    db.commit()


def _owned_asset(db,asset_id):
    data=get_record(db,'assets',asset_id)
    root=(Path(get_settings().upload_dir).resolve()/'assets').resolve()
    path=Path(str(data.get('path') or '')).resolve()
    if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size>MAX_IMAGE_BYTES or data.get('url')!='/uploads/assets/'+path.name:
        raise HTTPException(422,'ARTICLE_IMAGE_ASSET_INVALID')
    if data.get('contentType') not in {'image/png','image/jpeg'}:
        raise HTTPException(422,'ARTICLE_IMAGE_TYPE_INVALID')
    video.validate_media(path,'cover')
    return {'assetId':data['id'],'url':data['url'],'path':str(path),'altText':str(data.get('altText') or ''),'purpose':'inline'}


def _resolve_image(db,ref):
    if ref.get('assetId'):
        return _owned_asset(db,str(ref['assetId']))
    url=str(ref.get('url') or '')
    if not url.startswith('/uploads/assets/'):
        raise HTTPException(422,'ARTICLE_OWNED_IMAGE_REQUIRED')
    row=db.scalar(select(Record).where(Record.kind=='assets',Record.owner_id==current_owner_id(),Record.data['url'].as_string()==url).limit(1))
    if row is None:
        raise HTTPException(404,'ARTICLE_IMAGE_NOT_FOUND')
    return _owned_asset(db,row.id)


def _content(db,title,markdown,cover_id='',*,allow_owned_urls=False):
    if HTML_RE.search(markdown):
        raise HTTPException(422,'ARTICLE_HTML_NOT_SUPPORTED')
    if len(IMAGE_RE.findall(markdown))>5:
        raise HTTPException(422,'ARTICLE_TOO_MANY_IMAGES')
    images={}
    def replace(match):
        ref=match[2].strip()
        if ref.startswith('asset:'):
            asset=_owned_asset(db,ref[6:])
        elif allow_owned_urls:
            asset=_resolve_image(db,{'url':ref})
        else:
            raise HTTPException(422,'ARTICLE_OWNED_IMAGE_REQUIRED')
        images[asset['url']]=asset
        return '!['+match[1]+']('+asset['url']+')'
    markdown=IMAGE_RE.sub(replace,markdown)
    blocks=build_content_blocks({'title':title,'contentMarkdown':markdown},[])
    inline=[]
    for block in blocks:
        if block['type']=='image':
            asset=images.get(block.get('url'))
            if asset is None:
                raise HTTPException(422,'ARTICLE_IMAGE_NOT_FOUND')
            block.update({**asset,'sectionId':block.get('sectionId',''),'altText':block.get('altText') or asset['altText']})
            inline.append({k:v for k,v in block.items() if k!='type'})
    if blocks and blocks[0]['type']=='title':
        blocks[0]['text']=title
    cover={**_owned_asset(db,cover_id),'purpose':'cover'} if cover_id else {}
    return markdown,blocks,inline,cover


def import_article(db,*,title,contentMarkdown,idempotencyKey,summary='',tags=None,coverAssetId=''):
    title=title.strip(); markdown=contentMarkdown.replace('\r\n','\n').replace('\r','\n').strip()
    if not title or not markdown:
        raise HTTPException(422,'ARTICLE_CONTENT_REQUIRED')
    payload={'title':title,'contentMarkdown':markdown,'summary':summary.strip(),'tags':tags or [],'coverAssetId':coverAssetId}
    fingerprint=digest(payload)
    rid='mcp-article-'+digest([current_owner_id(),idempotencyKey])
    old=_row(db,'articles',rid)
    if old:
        if old.data.get('mcpInputHash')!=fingerprint:
            raise HTTPException(409,'MCP_IDEMPOTENCY_CONFLICT')
        return {'article':public_article(old.data),'deduplicated':True}
    markdown,blocks,inline,cover=_content(db,title,markdown,coverAssetId)
    data=default_article({'id':rid,'title':title,'contentMarkdown':markdown,'summary':summary,'tags':tags or [],'source':'mcp-import','status':'ready','writerContext':{},'contentBlocks':blocks,'inlineImages':inline,'coverImage':cover})
    data.update({'id':rid,'ownerId':current_owner_id(),'mcpInputHash':fingerprint})
    try:
        _insert(db,'articles',rid,data)
    except IntegrityError:
        db.rollback()
        old=_row(db,'articles',rid)
        if old is None or old.data.get('mcpInputHash')!=fingerprint:
            raise HTTPException(409,'MCP_IDEMPOTENCY_CONFLICT') from None
        return {'article':public_article(old.data),'deduplicated':True}
    return {'article':public_article(data),'deduplicated':False}


def capabilities(db):
    rows=db.scalars(select(Record).where(Record.kind=='mediaAccounts',Record.owner_id==current_owner_id()).order_by(Record.id).limit(501)).all()
    accounts=[]
    for row in rows[:500]:
        account=row.data
        if account.get('platform') not in PLATFORMS:
            continue
        binding=active_media_account_binding(db,row.id)
        device=find_record(db,'desktopDevices',str((binding or {}).get('deviceId') or '')) if binding else None
        authorized=media_account_has_active_credentials(db,account)
        online=desktop_device_is_live(device)
        device_capabilities=(device or {}).get('capabilities')
        supports_articles=isinstance(device_capabilities,dict) and device_capabilities.get('publish_article_v1') is True
        if not authorized:
            error='MEDIA_ACCOUNT_NOT_AUTHORIZED'
        elif not binding:
            error='MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED'
        elif not online:
            error='ARTICLE_DESKTOP_NOT_READY'
        elif not supports_articles:
            error='ARTICLE_DESKTOP_UPGRADE_REQUIRED'
        else:
            error=''
        accounts.append({'mediaAccountId':row.id,'name':account.get('name') or account.get('accountName') or '', 'platform':account['platform'],'authorized':authorized,'deviceId':(binding or {}).get('deviceId',''),'deviceOnline':online,'deviceSupportsArticles':supports_articles,'ready':not error,'error':error})
    return {'platforms':[{'id':k,'name':v,'supported':True} for k,v in PLATFORMS.items()]+[{'id':'wechat','name':'微信公众号','supported':False,'reason':'Adapter not implemented'}], 'accounts':accounts,'accountsTruncated':len(rows)>500,'maxArticleCharacters':20000,'maxInlineImages':5,'maxImageBytes':MAX_IMAGE_BYTES}


def page(db,kind,fields,limit=20,offset=0):
    rows=db.scalars(select(Record).where(Record.kind==kind,Record.owner_id==current_owner_id()).order_by(Record.created_at.desc(),Record.id.desc()).limit(limit+1).offset(offset)).all()
    items=[project(r.data,('id','title','summary','status','createdAt','updatedAt')) if kind=='articles' else project(r.data,fields) for r in rows[:limit]]
    return {'items':items,'nextOffset':offset+limit if len(rows)>limit else None}


def _safe_publish_article(db,article):
    # Discard writerContext/platformRules and resolve all image sources ourselves.
    markdown,_,_,_=_content(db,str(article.get('title') or ''),str(article.get('contentMarkdown') or ''),allow_owned_urls=True)
    blocks=build_content_blocks(article,article.get('inlineImages') or [])
    clean=[];inline=[]
    for raw in blocks:
        kind=raw.get('type')
        if kind=='image':
            asset={**_resolve_image(db,raw),'sectionId':str(raw.get('sectionId') or ''),'altText':str(raw.get('altText') or '')}
            inline.append(asset);clean.append({'type':'image',**asset})
        elif kind in {'title','section'}:
            block=project(raw,('type','text','title','content','sectionId'))
            if HTML_RE.search(str(block.get('content') or '')):
                raise HTTPException(422,'ARTICLE_HTML_NOT_SUPPORTED')
            clean.append(block)
    if len(inline)>5:
        raise HTTPException(422,'ARTICLE_TOO_MANY_IMAGES')
    cover={**_resolve_image(db,article['coverImage']),'purpose':'cover'} if article.get('coverImage') else {}
    return {**project(article,('id','title','summary','keywords','tags','sections')),'contentMarkdown':markdown,'contentBlocks':clean,'inlineImages':inline,'coverImage':cover,'writerContext':{}}


def _command_for_intent(db,intent):
    if intent.get('commandId'):
        row=_row(db,'desktopCommands',intent['commandId'])
        if row is not None:
            return row.data
    row=db.scalar(select(Record).where(Record.kind=='desktopCommands',Record.owner_id==current_owner_id(),Record.data['payload']['dedupeKey'].as_string()==intent['id']).limit(1))
    return row.data if row else None


def _publication(db,intent=None,order=None):
    intent=intent or {}
    command=_command_for_intent(db,intent) if intent else None
    oid=intent.get('mediaOrderId') or ((command or {}).get('result') or {}).get('mediaOrderId') or (order or {}).get('id')
    order=order or (find_record(db,'mediaOrders',str(oid)) if oid else None) or {}
    platform_status=str(order.get('platformStatus') or ((command or {}).get('result') or {}).get('platformStatus') or '')
    public_url=str(order.get('backlinkUrl') or '')
    # Legacy desktop publish events already validate public URLs/image evidence,
    # but predate publicVerifiedAt. Their complete evidence state is also valid.
    desktop_verified=(order.get('status')=='succeeded' and order.get('backlinkStatus') in {'published','generated'} and order.get('reviewStatus')=='public')
    verified=bool((order.get('publicVerifiedAt') or desktop_verified) and public_url.startswith(('https://','http://')) and platform_status=='published')
    if verified:
        state='published'
    elif platform_status in {'submitted_for_review','reviewing','pending_review'}:
        state='submitted_for_review'
    elif platform_status=='published_restricted':
        state='published_restricted'
    elif platform_status in {'manual_verification_required','account_under_review','quota_blocked','daily_publish_quota_zero','needs_reauth'}:
        state='manual_action_required'
    elif platform_status=='submission_unknown':
        state='submission_unknown'
    elif order.get('status') in {'failed','rejected'} or (command or {}).get('status')=='failed':
        state='failed'
    elif platform_status=='published':
        state='pending_public_visibility'
    elif order.get('status')=='review_required':
        state='submitted_for_review'
    elif (command or {}).get('status') in {'queued','running'}:
        state=command['status']
    elif command and command.get('status')=='succeeded':
        state='submission_unknown'
    else:
        state=intent.get('state') or ('queued' if platform_status=='queued' else 'submission_unknown')
    return {'id':intent.get('id') or order.get('id'),'articleId':intent.get('articleId') or order.get('articleId'),'mediaAccountId':intent.get('mediaAccountId') or order.get('mediaAccountId'),'platform':intent.get('platform') or order.get('platform'),'commandId':(command or {}).get('id') or order.get('sourceCommandId',''),'mediaOrderId':order.get('id') or oid or '', 'status':state,'platformStatus':platform_status,'publicUrl':public_url if verified else '', 'publicVerifiedAt':(order.get('publicVerifiedAt') or order.get('updatedAt') or '') if verified else '', 'message':str(order.get('errorMessage') or intent.get('message') or ''),'createdAt':intent.get('createdAt') or order.get('createdAt',''),'updatedAt':order.get('updatedAt') or intent.get('updatedAt','')}


def get_publication(db,publication_id):
    row=_row(db,INTENTS,publication_id)
    if row:
        return _publication(db,row.data)
    order=find_record(db,'mediaOrders',publication_id)
    if order and order.get('platform') in PLATFORMS:
        return _publication(db,order=order)
    raise HTTPException(404,'ARTICLE_PUBLICATION_NOT_FOUND')


def list_publications(db,limit=20,offset=0):
    # Order rows are canonical once created, including after an interrupted queue.
    command=aliased(Record);order=aliased(Record)
    attached=exists(select(1).select_from(command).join(order,order.id==command.data['result']['mediaOrderId'].as_string()).where(command.kind=='desktopCommands',command.owner_id==current_owner_id(),command.data['payload']['dedupeKey'].as_string()==Record.id,order.kind=='mediaOrders',order.owner_id==current_owner_id()))
    visible=or_(and_(Record.kind==INTENTS,~attached),and_(Record.kind=='mediaOrders',Record.data['platform'].as_string().in_(list(PLATFORMS))))
    rows=db.scalars(select(Record).where(Record.owner_id==current_owner_id(),visible).order_by(Record.created_at.desc(),Record.id.desc()).limit(limit+1).offset(offset)).all()
    items=[]
    for row in rows[:limit]:
        if row.kind==INTENTS:
            items.append(_publication(db,row.data))
        elif row.data.get('platform') in PLATFORMS:
            # Discovery may replace/clear sourceCommandId. The publishing command's
            # durable result still links the original intent to this order.
            intent_rows=aliased(Record)
            intent_ids=select(intent_rows.id).where(intent_rows.kind==INTENTS,intent_rows.owner_id==current_owner_id())
            cmd=db.scalar(select(Record).where(Record.kind=='desktopCommands',Record.owner_id==current_owner_id(),Record.data['type'].as_string()=='publish_article',Record.data['result']['mediaOrderId'].as_string()==row.id,Record.data['payload']['dedupeKey'].as_string().in_(intent_ids)).order_by(Record.created_at.desc(),Record.id.desc()).limit(1))
            key=str(((cmd.data if cmd else {}).get('payload') or {}).get('dedupeKey') or '')
            intent=_row(db,INTENTS,key) if key else None
            if intent is None:
                intent=db.scalar(select(Record).where(Record.kind==INTENTS,Record.owner_id==current_owner_id(),Record.data['mediaOrderId'].as_string()==row.id).limit(1))
            items.append(_publication(db,intent.data if intent else None,order=row.data))
    return {'items':items,'nextOffset':offset+limit if len(rows)>limit else None}


def publish_article(db,*,articleId,mediaAccountId,idempotencyKey,confirmPublish):
    if confirmPublish is not True:
        raise HTTPException(400,'PUBLISH_CONFIRMATION_REQUIRED')
    article=get_record(db,'articles',articleId)
    account=resolve_media_account(db,mediaAccountId)
    if account.get('platform') not in PLATFORMS:
        raise HTTPException(400,'ARTICLE_PLATFORM_NOT_SUPPORTED')
    safe=_safe_publish_article(db,article)
    fingerprint=digest([articleId,account['id'],safe])
    intent_id='mcp-article-publication-'+digest([current_owner_id(),articleId,account['id']])
    key_id='mcp-article-key-'+digest([current_owner_id(),idempotencyKey])
    for _ in range(3):
        prior_key=_row(db,KEYS,key_id)
        if prior_key and prior_key.data.get('inputHash')!=fingerprint:
            raise HTTPException(409,'MCP_IDEMPOTENCY_CONFLICT')
        prior=_row(db,INTENTS,intent_id)
        if prior:
            if prior.data.get('inputHash')!=fingerprint:
                raise HTTPException(409,'MCP_ARTICLE_TARGET_ALREADY_CLAIMED')
            if not prior_key:
                try:
                    _insert(db,KEYS,key_id,{'inputHash':fingerprint,'publicationId':intent_id})
                except IntegrityError:
                    db.rollback();continue
            return {'publication':_publication(db,prior.data),'deduplicated':True}
        if not media_account_has_active_credentials(db,account):
            raise HTTPException(400,'MEDIA_ACCOUNT_NOT_AUTHORIZED')
        binding=active_media_account_binding(db,account['id'])
        device=find_record(db,'desktopDevices',str((binding or {}).get('deviceId') or '')) if binding else None
        if not binding or not desktop_device_is_live(device):
            raise HTTPException(409,'ARTICLE_DESKTOP_NOT_READY')
        device_capabilities=(device or {}).get('capabilities')
        if not isinstance(device_capabilities,dict) or device_capabilities.get('publish_article_v1') is not True:
            raise HTTPException(409,'ARTICLE_DESKTOP_UPGRADE_REQUIRED')
        stamp=now_stamp()
        intent={'id':intent_id,'inputHash':fingerprint,'articleId':articleId,'mediaAccountId':account['id'],'platform':account['platform'],'state':'preparing','createdAt':stamp,'updatedAt':stamp}
        db.add(Record(id=intent_id,kind=INTENTS,owner_id=current_owner_id(),data=intent))
        if not prior_key:
            db.add(Record(id=key_id,kind=KEYS,owner_id=current_owner_id(),data={'inputHash':fingerprint,'publicationId':intent_id}))
        try:
            db.commit()
            break
        except IntegrityError:
            db.rollback()
    else:
        raise HTTPException(409,'MCP_ARTICLE_CLAIM_BUSY')
    try:
        queued=queue_article_media_publish_command(db,safe,account['id'],{'confirmPublish':True,'dedupeKey':intent_id,'submitIndex':False},source='mcp-publish-article')
        intent={**intent,'state':'queued','commandId':queued['command']['id'],'mediaOrderId':(queued.get('mediaOrder') or {}).get('id',''),'updatedAt':now_stamp()}
    except Exception:
        # Legacy commits may already have queued a real post. Never retry here.
        db.rollback()
        intent={**intent,'state':'reconciliation_required','message':'Submission preparation was interrupted. Query this publication; do not resubmit.','updatedAt':now_stamp()}
    row=_row(db,INTENTS,intent_id)
    row.data=intent;db.commit()
    return {'publication':_publication(db,intent),'deduplicated':False}


@contextmanager
def _serialized_recheck(db,order_id):
    """Keep a PG session advisory lock across the legacy helper's commits.

    Pin work to that same connection so lock waiters cannot exhaust the pool
    while its holder needs a second connection. SQLite uses process stripes.
    """
    key=int(digest([current_owner_id(),order_id])[:15],16)
    bind=db.get_bind()
    db.rollback()
    with RECHECK_LOCKS[key%len(RECHECK_LOCKS)]:
        if bind.dialect.name!='postgresql':
            yield db
            return
        with bind.connect() as connection:
            acquired=False
            try:
                connection.execute(text('SELECT pg_advisory_lock(:key)'),{'key':key})
                acquired=True
                connection.commit()
                with Session(bind=connection,autoflush=False) as pinned:
                    yield pinned
            finally:
                if acquired:
                    try:
                        connection.rollback()
                        unlocked=connection.execute(text('SELECT pg_advisory_unlock(:key)'),{'key':key}).scalar()
                        connection.commit()
                        if not unlocked:
                            raise RuntimeError('MCP recheck lock lost')
                    except BaseException:
                        # Never return a connection with a held advisory lock.
                        connection.invalidate()
                        raise


def recheck_publication(db,publication_id):
    publication=get_publication(db,publication_id)
    if publication['status']=='published':
        return {'publication':publication,'deduplicated':True}
    if not publication['mediaOrderId']:
        raise HTTPException(409,'ARTICLE_PUBLICATION_RECONCILIATION_REQUIRED')
    oid=publication['mediaOrderId']
    with _serialized_recheck(db,oid) as db:
        publication=get_publication(db,publication_id)
        active_task=db.scalar(select(TaskJob.id).where(TaskJob.owner_id==current_owner_id(),TaskJob.task_type=='media-publication-recheck',TaskJob.status.in_(['queued','pending','running']),TaskJob.payload['orderId'].as_string()==oid).limit(1))
        active_command=db.scalar(select(Record.id).where(Record.owner_id==current_owner_id(),Record.kind=='desktopCommands',Record.data['type'].as_string()=='discover_publication',Record.data['status'].as_string().in_(['queued','running']),Record.data['payload']['mediaOrderId'].as_string()==oid).limit(1))
        if active_task or publication['status'] in {'queued','running','preparing'}:
            return {'publication':get_publication(db,publication_id),'recheckQueued':bool(active_task),'deduplicated':True}
        # Same REST decision tree, imported only after app.main initialization.
        from .main import queue_media_publication_recheck
        options={'orderId':oid,'submitIndex':False,'sourceCommandId':publication['commandId']}
        # The original discovery helper handles stale devices and timed-out
        # running commands; a blanket "active" check would disable recovery.
        result=queue_media_publication_discovery(db,options) if active_command else queue_media_publication_recheck(db,options)
        return {'publication':get_publication(db,publication_id),'recheckQueued':True,'deduplicated':bool(result.get('deduplicated'))}


@router.post(ARTICLE_UPLOAD_PATH)
async def upload_image(request: Request,file: UploadFile=File(...),db=Depends(get_db)):
    identity=await run_in_threadpool(authenticate_request,request,ARTICLE_WRITE)
    filename=Path((file.filename or '').replace('\\','/')).name
    if Path(filename).suffix.lower() not in {'.png','.jpg','.jpeg'}:
        await file.close();raise HTTPException(422,'ARTICLE_IMAGE_TYPE_INVALID')
    root=Path(get_settings().upload_dir).resolve()/'assets';root.mkdir(parents=True,exist_ok=True)
    asset_id='asset-mcp-'+uuid4().hex
    temporary=root/(asset_id+'.part');target=None;size=0
    try:
        with temporary.open('xb') as output:
            while chunk:=await file.read(1024*1024):
                size+=len(chunk)
                if size>MAX_IMAGE_BYTES:
                    raise HTTPException(413,'ARTICLE_IMAGE_TOO_LARGE')
                await asyncio.to_thread(output.write,chunk)
        if not size:
            raise HTTPException(422,'ARTICLE_IMAGE_EMPTY')
        media=await run_in_threadpool(video.validate_media,temporary,'cover')
        codec=media.get('codec')
        if codec not in {'png','mjpeg','jpeg'}:
            raise HTTPException(422,'ARTICLE_IMAGE_TYPE_INVALID')
        target=root/(asset_id+('.png' if codec=='png' else '.jpg'));temporary.replace(target)
        identity=await run_in_threadpool(authenticate_request,request,ARTICLE_WRITE)
        with actor_scope(identity.actor):
            data={'id':asset_id,'filename':filename,'type':'inline','source':'upload','contentType':'image/png' if codec=='png' else 'image/jpeg','path':str(target),'url':'/uploads/assets/'+target.name,'sizeBytes':size,'altText':filename,'media':media,'createdAt':now_stamp(),'updatedAt':now_stamp()}
            await run_in_threadpool(_insert,db,'assets',asset_id,data)
        return project(data,ASSET_FIELDS)
    except BaseException:
        db.rollback();temporary.unlink(missing_ok=True)
        if target:target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
