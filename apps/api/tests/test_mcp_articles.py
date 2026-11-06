"""Multi-platform MCP publishing: owned inputs, explicit scope, durable intent."""
import json
from pathlib import Path

import pytest
from sqlalchemy import select

from app.auth.context import ActorContext, ActorRole, actor_scope
from app.config import get_settings
from app.database import Record, SessionLocal
from app.service import get_record, save_record
from app import video_publishing as video
from test_remote_mcp import http, reset, auth, call, credential, rpc, seed, web

PLATFORMS = ['zhihu','baijiahao','sohu','csdn','netease','penguin','toutiao','jianshu']
TOOLS = {'get_article_publish_capabilities','list_article_assets','import_article','list_articles','get_article','publish_article','list_article_publications','get_article_publication','recheck_article_publication'}


@pytest.fixture(autouse=True)
def image_storage(reset, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), 'upload_dir', str(tmp_path/'uploads'))
    monkeypatch.setattr(video, 'validate_media', lambda *args: {'width':1,'height':1,'codec':'png','duration':0})


def article_token(http, owner='alice'):
    return credential(http,owner,['publish:read','article:write'])['token']


def seed_article_account(platform='zhihu', owner='alice'):
    seed(owner)
    with SessionLocal() as db, actor_scope(ActorContext(owner,ActorRole.MEMBER)):
        r=db.get(Record,'account-'+owner);r.data={**r.data,'platform':platform};db.commit()


def image(http, token):
    r=http.post('/api/mcp/article-assets/upload',headers=auth(token),files={'file':('cover.png',b'valid image fixture','image/png')})
    assert r.status_code==200,r.text
    assert 'path' not in r.json() and r.json()['url'].startswith('/uploads/assets/')
    return r.json()['id']


def imported(http,token,key='draft-1',**extra):
    result,data=call(http,token,'import_article',{'title':'成品文章','contentMarkdown':'## 开始\n\n正文内容。','idempotencyKey':key,**extra})
    assert not result.get('isError'),data
    return data['article']['id']


def publish(http,token,article_id,key='publish-1',**extra):
    return call(http,token,'publish_article',{'articleId':article_id,'mediaAccountId':'account-alice','idempotencyKey':key,'confirmPublish':True,**extra})


def test_article_tools_discovered_without_removing_video(http):
    token=credential(http)['token']
    names={x['name'] for x in rpc(http,token,'tools/list')['result']['tools']}
    assert TOOLS<=names
    assert 'publish_video' in names


def test_new_scope_requires_read_and_old_video_write_cannot_write_articles(http):
    web(http)
    assert http.post('/api/mcp/tokens',json={'name':'invalid','scopes':['article:write']}).status_code==422
    token=credential(http)['token']
    result,data=call(http,token,'import_article',{'title':'x','contentMarkdown':'正文','idempotencyKey':'x'})
    assert result['isError'] and data['status']==403
    assert http.post('/api/mcp/article-assets/upload',headers=auth(token),files={'file':('x.png',b'x')}).status_code==403
    token=article_token(http)
    assert http.post('/api/mcp/video-assets/upload',headers=auth(token),files={'file':('x.mp4',b'x')}).status_code==403


def test_upload_auth_before_parse_revocation_and_bounded_images(http):
    assert http.post('/api/mcp/article-assets/upload',headers={'Content-Type':'multipart/form-data; boundary=x'},content=b'broken').status_code==401
    token=article_token(http)
    assert http.post('/api/mcp/article-assets/upload',headers=auth(token),files={'file':('bad.svg',b'<svg/>','image/svg+xml')}).status_code==422
    asset=image(http,token)
    _,listed=call(http,token,'list_article_assets')
    assert listed['items'][0]['id']==asset and 'path' not in json.dumps(listed)
    bob=article_token(http,'bob')
    assert call(http,bob,'list_article_assets')[1]['items']==[]
    assert http.post('/api/mcp/article-assets/upload',headers={**auth(token),'Content-Length':str(13*1024*1024)},content=b'').status_code==413


def test_import_preserves_image_position_is_idempotent_and_isolated(http):
    token=article_token(http);asset=image(http,token)
    markdown=f'## 第一节\n\n图片前。\n\n![配图](asset:{asset})\n\n图片后。'
    aid=imported(http,token,contentMarkdown=markdown,coverAssetId=asset)
    assert imported(http,token,contentMarkdown=markdown,coverAssetId=asset)==aid
    _,data=call(http,token,'get_article',{'articleId':aid})
    blocks=data['contentBlocks'];idx=next(i for i,b in enumerate(blocks) if b['type']=='image')
    assert '图片前' in blocks[idx-1]['content'] and '图片后' in blocks[idx+1]['content']
    assert blocks[idx]['assetId']==asset and 'path' not in json.dumps(data)
    result,_=call(http,token,'import_article',{'title':'different','contentMarkdown':markdown,'idempotencyKey':'draft-1'})
    assert result['isError']
    bob=article_token(http,'bob')
    assert call(http,bob,'get_article',{'articleId':aid})[0]['isError']
    assert call(http,bob,'list_articles')[1]['items']==[]
    result,_=call(http,bob,'import_article',{'title':'x','contentMarkdown':markdown,'idempotencyKey':'stolen'})
    assert result['isError']


@pytest.mark.parametrize('markdown',['![x](http://127.0.0.1/private)','![x](file:///etc/passwd)','![x](C:/secret.png)','<img src="http://internal/">'])
def test_import_rejects_remote_images_and_local_paths(http,markdown):
    token=article_token(http)
    assert call(http,token,'import_article',{'title':'x','contentMarkdown':markdown,'idempotencyKey':'bad'})[0]['isError']


@pytest.mark.parametrize('platform',PLATFORMS)
def test_existing_eight_platforms_route_to_real_queue_and_dedupe(http,platform):
    token=article_token(http);seed_article_account(platform)
    _,caps=call(http,token,'get_article_publish_capabilities')
    assert caps['accounts'][0]['ready'] is True
    assert set(PLATFORMS)=={p['id'] for p in caps['platforms'] if p['supported']}
    assert 'must-never-leak' not in json.dumps(caps) and 'cookies' not in json.dumps(caps)
    aid=imported(http,token)
    result,first=publish(http,token,aid)
    assert not result.get('isError'),first
    pub=first['publication'];assert pub['commandId'] and pub['mediaOrderId']
    _,again=publish(http,token,aid,key='different-network-key')
    assert again['publication']['id']==pub['id'] and again['deduplicated']
    with SessionLocal() as db:
        commands=db.scalars(select(Record).where(Record.kind=='desktopCommands')).all()
        assert len(commands)==1
        assert commands[0].data['payload']['platform']==platform
        assert commands[0].data['payload']['confirmPublish'] is True
        assert commands[0].data['payload']['submitIndex'] is False
    _,status=call(http,token,'get_article_publication',{'publicationId':pub['id']})
    assert status['status']=='queued' and 'payload' not in json.dumps(status)
    bob=article_token(http,'bob')
    assert call(http,bob,'get_article_publication',{'publicationId':pub['id']})[0]['isError']
    assert call(http,bob,'list_article_publications')[1]['items']==[]


def test_publish_confirmation_unknown_platform_and_idempotency_conflict(http):
    token=article_token(http);seed_article_account('wechat');aid=imported(http,token)
    assert publish(http,token,aid)[0]['isError']
    seed_article_account('zhihu')
    assert publish(http,token,aid,confirmPublish=False)[0]['isError']
    invalid=rpc(http,token,'tools/call',{'name':'publish_article','arguments':{'articleId':aid,'mediaAccountId':'account-alice','idempotencyKey':'publish-1','confirmPublish':'true'}})
    assert invalid['result']['isError']
    assert not publish(http,token,aid)[0].get('isError')
    other=imported(http,token,'draft-2')
    assert publish(http,token,other)[0]['isError']


def test_publish_requires_desktop_article_capability(http):
    token=article_token(http);seed_article_account();aid=imported(http,token)
    with SessionLocal() as db:
        device=get_record(db,'desktopDevices','device-alice');device['capabilities']={'publish_video_v1':True};save_record(db,'desktopDevices',device)
    result,data=publish(http,token,aid)
    assert result['isError'] and data['status']==409 and data['error']=='ARTICLE_DESKTOP_UPGRADE_REQUIRED'
    _,caps=call(http,token,'get_article_publish_capabilities')
    account=caps['accounts'][0]
    assert account['ready'] is False and account['deviceSupportsArticles'] is False and account['error']=='ARTICLE_DESKTOP_UPGRADE_REQUIRED'
    with SessionLocal() as db:
        device=get_record(db,'desktopDevices','device-alice');device['capabilities']={'publish_video_v1':True,'publish_article_v1':True};save_record(db,'desktopDevices',device)
    assert not publish(http,token,aid)[0].get('isError')


def test_article_capability_registration_and_heartbeat_without_reregistration(http):
    registered=http.post('/api/desktop-devices/register',json={'deviceName':'article-cap','appVersion':'0.1.18','capabilities':{'publish_video_v1':True,'publish_article_v1':True}})
    assert registered.status_code==200,registered.text
    device=registered.json()['device'];did=device['id']
    assert device['capabilities']['publish_article_v1'] is True
    with SessionLocal() as db:
        row=get_record(db,'desktopDevices',did);row['capabilities']={'publish_video_v1':True};save_record(db,'desktopDevices',row)
    response=http.post('/api/desktop-events',headers={'x-device-id':did,'x-device-token':registered.json()['deviceToken']},json={'type':'heartbeat','payload':{'capabilities':{'publish_video_v1':True,'publish_article_v1':True}}})
    assert response.status_code==200,response.text
    with SessionLocal() as db:
        assert get_record(db,'desktopDevices',did)['capabilities']['publish_article_v1'] is True


def test_partial_queue_failure_never_requeues_and_status_recovers_command(http,monkeypatch):
    import app.mcp_articles as articles
    token=article_token(http);seed_article_account();aid=imported(http,token)
    original=articles.queue_article_media_publish_command
    def crash(*args,**kwargs):
        original(*args,**kwargs)
        raise RuntimeError('simulated response loss')
    monkeypatch.setattr(articles,'queue_article_media_publish_command',crash)
    first,result=publish(http,token,aid)
    assert not first.get('isError'),result
    assert result['publication']['status'] in {'queued','reconciliation_required'}
    second,repeated=publish(http,token,aid,key='retry-other-key')
    assert not second.get('isError') and repeated['deduplicated']
    with SessionLocal() as db:
        assert len(db.scalars(select(Record).where(Record.kind=='desktopCommands')).all())==1


def test_legacy_publication_visible_and_published_requires_public_evidence(http):
    token=article_token(http);seed_article_account();aid=imported(http,token)
    _,result=publish(http,token,aid);pub=result['publication']
    with SessionLocal() as db:
        row=db.get(Record,pub['mediaOrderId']);row.data={**row.data,'status':'published','platformStatus':'submitted_for_review','backlinkUrl':'','publicVerifiedAt':''};db.commit()
    _,state=call(http,token,'get_article_publication',{'publicationId':pub['id']})
    assert state['status']!='published'
    with SessionLocal() as db,actor_scope(ActorContext('alice',ActorRole.MEMBER)):
        save_record(db,'mediaOrders',{'id':'historical-order','platform':'zhihu','mediaAccountId':'account-alice','articleId':aid,'status':'pending','platformStatus':'submitted_for_review'})
    _,items=call(http,token,'list_article_publications')
    assert any(x['id']=='historical-order' for x in items['items'])


def test_publication_list_has_no_duplicate_aliases_and_article_list_is_summary(http):
    token=article_token(http);seed_article_account();aid=imported(http,token)
    _,result=publish(http,token,aid)
    _,items=call(http,token,'list_article_publications')
    assert len(items['items'])==1
    assert items['items'][0]['id']==result['publication']['id']
    _,articles=call(http,token,'list_articles')
    assert 'contentMarkdown' not in articles['items'][0]


def test_recheck_deduplicates_existing_backend_tasks(http,monkeypatch):
    from app.queue import MemoryQueueClient
    from app import main
    import app.service as service
    monkeypatch.setattr(service,'queue_client',MemoryQueueClient())
    token=article_token(http);seed_article_account('csdn');aid=imported(http,token)
    _,result=publish(http,token,aid);pub=result['publication']
    with SessionLocal() as db:
        row=db.get(Record,pub['mediaOrderId']);row.data={**row.data,'status':'review_required','platformStatus':'submitted_for_review','reviewUrl':'https://blog.csdn.net/example/article/details/123'};db.commit()
    first,data=call(http,token,'recheck_article_publication',{'publicationId':pub['id']})
    assert not first.get('isError'),data
    assert call(http,token,'list_article_publications')[1]['items'][0]['id']==pub['id']
    second,data=call(http,token,'recheck_article_publication',{'publicationId':pub['id']})
    assert not second.get('isError') and data['deduplicated']
    with SessionLocal() as db:
        tasks=db.scalars(select(Record).where(Record.kind=='tasks')).all()
        assert len(tasks)==1


def test_concurrent_publish_claims_queue_once(http):
    from concurrent.futures import ThreadPoolExecutor
    import app.mcp_articles as articles
    token=article_token(http);seed_article_account();aid=imported(http,token)
    def run(i):
        with SessionLocal() as db,actor_scope(ActorContext('alice',ActorRole.MEMBER)):
            return articles.publish_article(db,articleId=aid,mediaAccountId='account-alice',idempotencyKey='parallel-'+str(i),confirmPublish=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(run,range(4)))
    assert len({x['publication']['id'] for x in results})==1
    with SessionLocal() as db:
        assert len(db.scalars(select(Record).where(Record.kind=='desktopCommands')).all())==1


def test_image_upload_revalidates_after_transfer_and_removes_file(http,monkeypatch):
    from app.service import now_stamp
    token=article_token(http)
    def revoke_during_validation(*args):
        with SessionLocal() as db:
            row=db.get(Record,'mcp-token-'+token.split('.')[0].removeprefix('zx_mcp_'))
            row.data={**row.data,'revokedAt':now_stamp()};db.commit()
        return {'width':1,'height':1,'codec':'png'}
    monkeypatch.setattr(video,'validate_media',revoke_during_validation)
    r=http.post('/api/mcp/article-assets/upload',headers=auth(token),files={'file':('x.png',b'fixture','image/png')})
    assert r.status_code==401
    assert list((Path(get_settings().upload_dir)/'assets').iterdir())==[]


def test_desktop_public_event_is_reflected_without_extra_recheck(http):
    token=article_token(http);seed_article_account('csdn');aid=imported(http,token)
    _,result=publish(http,token,aid);pub=result['publication']
    response=http.post(f"/api/desktop-commands/{pub['commandId']}/events",headers={'x-device-id':'device-alice','x-device-token':'device-secret'},json={'type':'publish_succeeded','payload':{'platformStatus':'published','publishedUrl':'https://blog.csdn.net/example/article/details/123456','publiclyVisible':True,'pageText':'成品文章 正文内容。'}})
    assert response.status_code==200,response.text
    _,state=call(http,token,'get_article_publication',{'publicationId':pub['id']})
    assert state['status']=='published'


def test_review_desktop_discovery_to_public_deduplicates(http):
    token=article_token(http);seed_article_account('toutiao');aid=imported(http,token)
    _,result=publish(http,token,aid);pub=result['publication']
    headers={'x-device-id':'device-alice','x-device-token':'device-secret'}
    r=http.post(f"/api/desktop-commands/{pub['commandId']}/events",headers=headers,json={'type':'publish_succeeded','payload':{'platformStatus':'submitted_for_review','reviewUrl':'','submissionAccepted':True}})
    assert r.status_code==200,r.text
    assert call(http,token,'get_article_publication',{'publicationId':pub['id']})[1]['status']=='submitted_for_review'
    first,data=call(http,token,'recheck_article_publication',{'publicationId':pub['id']})
    assert not first.get('isError'),data
    assert call(http,token,'list_article_publications')[1]['items'][0]['id']==pub['id']
    second,data=call(http,token,'recheck_article_publication',{'publicationId':pub['id']})
    assert not second.get('isError') and data['deduplicated']
    with SessionLocal() as db:
        command=db.scalar(select(Record).where(Record.kind=='desktopCommands',Record.data['type'].as_string()=='discover_publication'))
        cid=command.id
    r=http.post(f'/api/desktop-commands/{cid}/events',headers=headers,json={'type':'publication_discovery_succeeded','payload':{'found':True,'platformStatus':'published','publicUrl':'https://www.toutiao.com/article/123456789/','pageText':'成品文章 正文内容。','publiclyVisible':True}})
    assert r.status_code==200,r.text
    assert call(http,token,'get_article_publication',{'publicationId':pub['id']})[1]['status']=='published'


def test_stale_desktop_recheck_can_recover(http):
    from datetime import timedelta
    from app import app_time
    token=article_token(http);seed_article_account('toutiao');aid=imported(http,token)
    _,result=publish(http,token,aid);pub=result['publication']
    with SessionLocal() as db:
        row=db.get(Record,pub['mediaOrderId']);row.data={**row.data,'status':'review_required','platformStatus':'submitted_for_review'};db.commit()
    assert not call(http,token,'recheck_article_publication',{'publicationId':pub['id']})[0].get('isError')
    with SessionLocal() as db:
        command=db.scalar(select(Record).where(Record.kind=='desktopCommands',Record.data['type'].as_string()=='discover_publication'))
        old=command.id;command.data={**command.data,'status':'running','updatedAt':(app_time.now()-timedelta(hours=2)).isoformat()};db.commit()
    first,data=call(http,token,'recheck_article_publication',{'publicationId':pub['id']})
    assert not first.get('isError') and not data['deduplicated']
    with SessionLocal() as db:
        assert db.get(Record,old).data['status']=='failed'
        commands=db.scalars(select(Record).where(Record.kind=='desktopCommands',Record.data['type'].as_string()=='discover_publication')).all()
        assert len(commands)==2
