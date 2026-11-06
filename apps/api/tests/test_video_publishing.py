import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.database import Base, SessionLocal, engine
from app.service import save_record, get_record
from app.auth.context import ActorContext, ActorRole, actor_scope
from app import video_publishing as video

client = TestClient(app)

@pytest.fixture(autouse=True)
def setup(tmp_path, monkeypatch):
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setenv('ZX_PRIVATE_VIDEO_DIR', str(tmp_path))
    monkeypatch.setattr(video, 'validate_media', lambda path, kind: {'duration': 1, 'width': 1280, 'height': 720})


def seed(capable=True, owner='test-owner'):
    with SessionLocal() as db, actor_scope(ActorContext(owner, ActorRole.MEMBER)):
        from app.app_time import now_stamp
        save_record(db, 'desktopDevices', {'id': 'vd', 'boundOwnerId': owner, 'status': 'active', 'lastSeenAt': now_stamp(), 'deviceTokenHash': hashlib.sha256(b'token').hexdigest(), 'capabilities': {'publish_video_v1': capable}})
        save_record(db, 'mediaAuthArtifacts', {'id': 'vauth', 'status': 'active', 'authorizationEvidence': {'strongCookiePresent': True, 'workspaceReady': True}})
        save_record(db, 'mediaAccounts', {'id': 'vacc', 'platform': 'douyin', 'status': 'active', 'credentialStatus': 'active', 'authArtifactId': 'vauth', 'platformAccountId': 'douyin-user'})
        save_record(db, 'mediaAccountBindings', {'id': 'vbind', 'mediaAccountId': 'vacc', 'deviceId': 'vd', 'status': 'active'})


def upload(content=b'test mp4', kind='video'):
    return client.post('/api/video-assets/upload', files={'file': ('sample.mp4' if kind=='video' else 'cover.png', content, 'video/mp4')}, data={'kind':kind})


def queue(asset_id, key='intent-one'):
    return client.post('/api/video-publications', json={'assetId':asset_id, 'mediaAccountId':'vacc', 'caption':'Test', 'idempotencyKey':key})


def event(command_id, type, payload):
    return client.post(f'/api/desktop-commands/{command_id}/events', headers={'x-device-id':'vd','x-device-token':'token'}, json={'type':type, 'payload':payload})


def test_private_streamed_upload_metadata_and_limits(monkeypatch):
    result = upload().json()
    assert result['sha256'] == hashlib.sha256(b'test mp4').hexdigest()
    assert result['sizeBytes'] == 8
    assert 'path' not in result and 'url' not in result
    monkeypatch.setattr(video,'MAX_VIDEO_BYTES',4)
    assert upload().status_code == 413
    assert len(list(video.private_root().glob('*.part'))) == 0
    assert client.post('/api/video-assets/upload',files={'file':('x.exe',b'test')}).status_code == 415


def test_upload_decode_rejection_leaves_no_file(monkeypatch):
    from fastapi import HTTPException
    def reject(*args): raise HTTPException(422,'VIDEO_INVALID_MEDIA')
    monkeypatch.setattr(video,'validate_media',reject)
    assert upload().status_code == 422
    assert list(video.private_root().iterdir()) == []


def test_bound_capability_required_and_private_download_checks():
    seed(False)
    asset=upload().json()
    assert queue(asset['id']).json()['detail'] == 'DESKTOP_VIDEO_UPGRADE_REQUIRED'
    with SessionLocal() as db:
        d=get_record(db,'desktopDevices','vd'); d['capabilities']={'publish_video_v1':True}; save_record(db,'desktopDevices',d)
    result=queue(asset['id']).json()
    command=result['command']
    path=command['payload']['videoAsset']['downloadPath']+'?commandId='+command['id']
    assert client.get(path).status_code == 403
    assert client.get(path,headers={'x-device-id':'vd','x-device-token':'token'}).content == b'test mp4'
    other=upload(b'other').json()
    assert client.get(f"/api/video-assets/{other['id']}/content?commandId={command['id']}",headers={'x-device-id':'vd','x-device-token':'token'}).status_code == 403


def test_foreign_asset_denied():
    seed()
    with SessionLocal() as db, actor_scope(ActorContext('another',ActorRole.MEMBER)):
        save_record(db,'videoAssets',{'id':'foreign','kind':'video','sha256':'x','sizeBytes':2})
    assert queue('foreign').status_code == 404


def test_duplicate_submission_and_unknown_result_cannot_requeue():
    seed(); asset=upload().json(); first=queue(asset['id']).json()
    assert queue(asset['id']).json()['deduplicated'] is True
    assert queue(asset['id'],'new-key').json()['command']['id'] == first['command']['id']
    command_id=first['command']['id']
    assert event(command_id,'publish_progress',{'stage':'submitting'}).status_code == 200
    failed=event(command_id,'publish_failed',{'errorMessage':'network lost'})
    assert failed.status_code == 200
    assert failed.json()['publication']['status'] == 'submission_unknown'
    assert queue(asset['id'],'another-key').json()['deduplicated'] is True
    assert client.post(f"/api/video-publications/{first['publication']['id']}/discover").status_code == 409


def test_review_not_public_and_discovery_id_required():
    seed(); first=queue(upload().json()['id']).json(); cid=first['command']['id']
    result=event(cid,'publish_succeeded',{'platformStatus':'submitted_for_review','submissionAccepted':True,'itemId':'123'})
    assert result.json()['publication']['status']=='submitted_for_review'
    response=client.post(f"/api/video-publications/{first['publication']['id']}/discover")
    assert response.status_code==200
    discovery=response.json()['command']
    wrong=event(discovery['id'],'publication_discovery_succeeded',{'platformStatus':'published','found':True,'itemId':'999','publicUrl':'https://www.douyin.com/video/999'})
    assert wrong.status_code==409
    pending=event(discovery['id'],'publication_discovery_succeeded',{'platformStatus':'submitted_for_review','itemId':'123','found':False})
    assert pending.json()['publication']['status']=='submitted_for_review'


def test_generic_publish_video_command_endpoint_cannot_bypass_validation():
    assert client.post('/api/desktop-commands',json={'type':'publish_video','payload':{}}).status_code==400

def test_reused_idempotency_key_cannot_publish_another_video():
    seed(); first=queue(upload().json()['id'])
    assert first.status_code==200
    assert queue(upload(b'other video').json()['id']).status_code==409


def test_published_requires_both_endpoint_evidence():
    seed(); first=queue(upload().json()['id']).json()
    event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True})
    did=client.post(f"/api/video-publications/{first['publication']['id']}/discover").json()['command']['id']
    result=event(did,'publication_discovery_succeeded',{'itemId':'123','found':True,'platformStatus':'published','publicUrl':'https://www.douyin.com/video/123'})
    assert result.json()['publication']['status']=='submitted_for_review'


def test_request_size_rejected_before_multipart_parse(monkeypatch):
    monkeypatch.setattr(video,'MAX_VIDEO_BYTES',4)
    assert client.post('/api/video-assets/upload',content=b'x',headers={'content-length':'3000000','content-type':'multipart/form-data; boundary=x'}).status_code==413


def test_scheduler_does_not_repost_lost_submitting_command():
    from datetime import timedelta
    from app import app_time
    seed(); first=queue(upload().json()['id']).json(); cid=first['command']['id']
    event(cid,'publish_progress',{'stage':'submitting'})
    with SessionLocal() as db, actor_scope(ActorContext('test-owner',ActorRole.MEMBER)):
        command=get_record(db,'desktopCommands',cid)
        command['updatedAt']=(app_time.now()-timedelta(hours=3)).isoformat()
        save_record(db,'desktopCommands',command)
        assert video.enqueue_video_discoveries(db)==0
        assert get_record(db,'videoPublications',first['publication']['id'])['status']=='submission_unknown'


def test_concurrent_same_video_is_one_command():
    from concurrent.futures import ThreadPoolExecutor
    seed(); asset=upload().json()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda key:queue(asset['id'],key), ['a','b']))
    assert [r.status_code for r in results]==[200,200]
    assert results[0].json()['command']['id']==results[1].json()['command']['id']


def test_real_mp4_validation_and_corrupt_file(tmp_path, monkeypatch):
    import shutil, subprocess, importlib
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('ffmpeg unavailable')
    # Reloading just this function avoids turning the upload fixtures into a
    # fake proof of media validation.
    original=importlib.reload(video).validate_media
    target=tmp_path/'valid.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=black:s=64x64:d=0.1','-c:v','libx264','-y',str(target)],check=True,timeout=30)
    checked=original(target,'video')
    assert checked['codec']=='h264' and checked['width']==64
    target.write_bytes(b'not a video')
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        original(target,'video')
    assert exc.value.status_code==422

def test_cleanup_protects_every_referenced_asset(tmp_path):
    from datetime import timedelta
    from app import app_time
    seed(); used=upload().json(); queue(used['id'])
    orphan=upload(b'orphan').json()
    with SessionLocal() as db, actor_scope(ActorContext('test-owner',ActorRole.MEMBER)):
        for asset_id in (used['id'],orphan['id']):
            asset=get_record(db,'videoAssets',asset_id);asset['createdAt']=(app_time.now()-timedelta(days=8)).isoformat();save_record(db,'videoAssets',asset)
        assert video.cleanup_unused_video_assets(db)==1
        assert Path(get_record(db,'videoAssets',used['id'])['path']).is_file()
        assert video.find_record(db,'videoAssets',orphan['id']) is None

def test_failed_before_submission_can_retry_with_new_intent_only():
    seed(); asset=upload().json(); first=queue(asset['id'],'first').json()
    failed=event(first['command']['id'],'publish_failed',{'errorMessage':'DOUYIN_LOGIN_REQUIRED'}).json()
    assert failed['publication']['status']=='failed'
    assert queue(asset['id'],'first').json()['command']['id']==first['command']['id']
    second=queue(asset['id'],'retry').json()
    assert second['deduplicated'] is False
    assert second['command']['id']!=first['command']['id']
    assert second['publication']['attempt']==2

def test_retry_endpoint_replays_but_rejects_uncertain_submission():
    seed(); first=queue(upload().json()['id']).json(); pid=first['publication']['id']
    event(first['command']['id'],'publish_failed',{'errorMessage':'upload failed'})
    retried=client.post(f'/api/video-publications/{pid}/retry',json={'idempotencyKey':'retry-key'})
    assert retried.status_code==200 and retried.json()['publication']['attempt']==2
    command=retried.json()['command']
    assert client.post(f'/api/video-publications/{pid}/retry',json={'idempotencyKey':'retry-key'}).json()['deduplicated'] is True
    event(command['id'],'publish_progress',{'stage':'submitting'})
    event(command['id'],'publish_failed',{'errorMessage':'network lost'})
    assert client.post(f'/api/video-publications/{pid}/retry',json={'idempotencyKey':'another'}).status_code==409


def test_upload_requires_disk_space(monkeypatch):
    from collections import namedtuple
    usage=namedtuple('usage','total used free')
    monkeypatch.setattr(video.shutil,'disk_usage',lambda root:usage(100,99,1))
    assert upload().status_code==507

@pytest.mark.parametrize('caption,expected', [('文'*1000,200),('文'*1001,400),('😀'*1000,200),('😀'*1001,400)], ids=['cjk-1000','cjk-1001','emoji-1000','emoji-1001'])
def test_caption_limit_is_1000_unicode_code_points(caption,expected):
    seed(); asset=upload().json()
    result=client.post('/api/video-publications',json={'assetId':asset['id'],'mediaAccountId':'vacc','caption':caption,'idempotencyKey':'caption-boundary'})
    assert result.status_code==expected
    if expected==200:
        assert result.json()['command']['payload']['caption']==caption

@pytest.mark.parametrize('published',[True,False],ids=['public','pending'])
def test_discovery_persists_sanitized_evidence_with_server_timestamp(published):
    seed(); first=queue(upload().json()['id']).json()
    event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True})
    did=client.post(f"/api/video-publications/{first['publication']['id']}/discover").json()['command']['id']
    response=event(did,'publication_discovery_succeeded',{
        'itemId':'123','found':published,'platformStatus':'published' if published else 'submitted_for_review',
        'publicUrl':'https://www.douyin.com/video/123' if published else '',
        'publicationEvidence':{'workListVerified':published,'detailVerified':published,'checkedAt':'client-untrusted','cookie':'secret'},
        'evidence':{'itemId':'123','statusValue':102 if published else 141,'selfSee':not published,'reviewStatus':2,'visibility':0,'workMatched':True,'detailMatched':True,'checkedAt':'client-untrusted','token':'secret','rawResponse':{'secret':'hidden'}}
    })
    assert response.status_code==200
    body=response.json()
    assert body['publication']['status']==('published' if published else 'submitted_for_review')
    for target in (body['command']['result'],body['event']['payload']):
        assert target['publicationEvidence']['workListVerified'] is published
        assert target['publicationEvidence']['detailVerified'] is published
        assert target['publicationEvidence']['checkedAt']!='client-untrusted'
        assert set(target['publicationEvidence'])=={'workListVerified','detailVerified','checkedAt'}
        assert target['evidence']['statusValue']==(102 if published else 141)
        assert target['evidence']['checkedAt']==target['publicationEvidence']['checkedAt']
        assert 'token' not in target['evidence'] and 'rawResponse' not in target['evidence']
    with SessionLocal() as db:
        stored=get_record(db,'desktopCommands',did)['result']
        assert stored['publicationEvidence']==body['command']['result']['publicationEvidence']

def test_worker_cli_periodic_tick_discovers_video_added_after_startup():
    from app import worker_cli
    from app.service import list_records
    with SessionLocal() as db, actor_scope(None):
        last,_=worker_cli.run_scheduler_if_due(db,object(),True,None,60,now=100)
    seed(); first=queue(upload().json()['id']).json()
    event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True})
    with SessionLocal() as db, actor_scope(None):
        _,result=worker_cli.run_scheduler_if_due(db,object(),True,last,60,now=160)
        commands=list_records(db,'desktopCommands')
        discoveries=[c for c in commands if c['type']=='discover_publication']
        assert len(discoveries)==1
        assert discoveries[0]['payload']['itemId']=='123'
        assert result['videoPublicationDiscovery']==1
        assert len([c for c in commands if c['type']=='publish_video'])==1


def test_periodic_tick_replaces_lost_discovery_without_reposting():
    from app import worker_cli, app_time
    from app.service import list_records
    from datetime import timedelta
    seed(); first=queue(upload().json()['id']).json(); pid=first['publication']['id']
    event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True})
    old=client.post(f'/api/video-publications/{pid}/discover').json()['command']
    with SessionLocal() as db, actor_scope(ActorContext('test-owner',ActorRole.MEMBER)):
        old['status']='running';old['updatedAt']=(app_time.now()-timedelta(hours=2)).isoformat();save_record(db,'desktopCommands',old)
        publication=get_record(db,'videoPublications',pid);publication['nextDiscoveryAt']=(app_time.now()-timedelta(minutes=1)).isoformat();save_record(db,'videoPublications',publication)
    with SessionLocal() as db, actor_scope(None):
        _,result=worker_cli.run_scheduler_if_due(db,object(),True,100,60,now=160)
        publication=get_record(db,'videoPublications',pid)
        assert publication['discoveryCommandId']!=old['id']
        assert get_record(db,'desktopCommands',old['id'])['status']=='failed'
        assert result['videoPublicationDiscovery']==1
        assert len([c for c in list_records(db,'desktopCommands') if c['type']=='publish_video'])==1


def test_startup_invokes_video_discovery_only_once_per_owner(monkeypatch):
    from app.worker import Scheduler
    calls=[]
    monkeypatch.setattr(video,'enqueue_video_discoveries',lambda db:calls.append('called') or 0)
    with SessionLocal() as db, actor_scope(ActorContext('test-owner',ActorRole.MEMBER)):
        Scheduler(db,object()).enqueue_due_jobs()
    assert calls==['called']


def test_worker_cli_periodic_maintenance_cleans_only_orphan_video():
    from app import worker_cli, app_time
    from datetime import timedelta
    seed(); used=upload().json();queue(used['id']);orphan=upload(b'unused').json()
    with SessionLocal() as db, actor_scope(ActorContext('test-owner',ActorRole.MEMBER)):
        for asset_id in (used['id'],orphan['id']):
            asset=get_record(db,'videoAssets',asset_id);asset['createdAt']=(app_time.now()-timedelta(days=8)).isoformat();save_record(db,'videoAssets',asset)
    with SessionLocal() as db, actor_scope(None):
        stamp,result=worker_cli.run_maintenance_if_due(db,object(),True,100,21600,now=21700)
        assert stamp==21700
        assert video.find_record(db,'videoAssets',orphan['id']) is None
        assert video.find_record(db,'videoAssets',used['id']) is not None


def preparation_evidence():
    return {
        'topics':{'requested':['监控安装'],'resolved':[{'name':'监控安装','id':'123'}],'verified':True,'token':'secret'},
        'chapters':{'source':'platform_smart','count':3,'verified':True,'url':'https://secret.invalid'},
        'cover':{'source':'platform_ai','verified':True,'horizontal':{'width':1920,'height':1080,'verified':True,'url':'https://secret.invalid'},'vertical':{'width':1080,'height':1920,'verified':True}},
        'cookie':'secret',
    }


def test_preparation_evidence_persists_without_promoting_publication():
    seed(); first=queue(upload().json()['id']).json();cid=first['command']['id']
    response=event(cid,'publish_progress',{'stage':'prepared','preparationEvidence':preparation_evidence()})
    assert response.status_code==200
    result=response.json()
    assert result['publication']['status']=='running' and result['publication']['stage']=='prepared'
    for target in (result['publication'],result['command']['result'],result['event']['payload']):
        evidence=target['preparationEvidence']
        assert set(evidence)=={'topics','chapters','cover'}
        assert evidence['topics']=={'requested':['监控安装'],'resolved':[{'name':'监控安装','id':'123'}],'verified':True}
        assert evidence['chapters']=={'source':'platform_smart','count':3,'verified':True}
        assert set(evidence['cover']['horizontal'])=={'width','height','verified'}
    final=event(cid,'publish_succeeded',{'itemId':'123','submissionAccepted':True,'platformStatus':'published','preparationEvidence':preparation_evidence()}).json()
    assert final['publication']['status']=='submitted_for_review'
    assert final['command']['result']['preparationEvidence']['cover']['verified'] is True


@pytest.mark.parametrize('bad',[
    ['not a mapping'],
    {'topics':{'requested':['x']*21,'resolved':[],'verified':True}},
    {'topics':{'requested':['x'],'resolved':[{'name':'x','id':'https://secret.invalid'}],'verified':True}},
    {'topics':{'requested':['x'*101],'resolved':[],'verified':True}},
    {'chapters':{'source':'https://secret.invalid','count':1,'verified':True}},
    {'chapters':{'source':'platform_smart','count':True,'verified':True}},
    {'cover':{'source':'platform_ai','verified':True,'horizontal':{'width':999999999,'height':1,'verified':True},'vertical':{'width':1,'height':1,'verified':True}}},
])
def test_malformed_preparation_evidence_is_not_saved(bad):
    seed(); first=queue(upload().json()['id']).json()
    response=event(first['command']['id'],'publish_progress',{'stage':'prepared','preparationEvidence':bad})
    assert response.status_code==200
    for target in (response.json()['publication'],response.json()['command']['result'],response.json()['event']['payload']):
        assert 'preparationEvidence' not in target
    assert response.json()['publication']['status']=='running'

@pytest.fixture
def schedule_clock(monkeypatch):
    from datetime import datetime
    fixed=datetime.fromisoformat('2026-10-27T10:00:00+08:00')
    monkeypatch.setattr(video.app_time,'now',lambda:fixed)
    return fixed


def schedule_seed(enabled=True):
    seed()
    with SessionLocal() as db:
        device=get_record(db,'desktopDevices','vd')
        device['capabilities']['publish_video_schedule_v1']=enabled
        save_record(db,'desktopDevices',device)


def schedule_queue(asset_id, **changes):
    return client.post('/api/video-publications',json={'assetId':asset_id,'mediaAccountId':'vacc','caption':'说明','title':'独立标题','idempotencyKey':'schedule-key','publishMode':'scheduled','scheduledAt':'2026-10-27T13:00:00+08:00',**changes})


@pytest.mark.parametrize('title,status',[('',200),('文'*30,200),('😀'*30,200),('文'*31,400),('😀'*31,400),(123,400)],ids=['empty','cjk30','emoji30','cjk31','emoji31','not-string'])
def test_independent_title_code_point_limit(title,status):
    seed();asset=upload().json()
    response=schedule_queue(asset['id'],title=title,publishMode='immediate',scheduledAt='')
    assert response.status_code==status
    if status==200:
        assert response.json()['command']['payload']['title']==title
        assert response.json()['command']['payload']['caption']=='说明'


@pytest.mark.parametrize('stamp,status',[
    ('2026-10-27T12:00:00+08:00',200),
    ('2026-11-10T10:00:00+08:00',200),
    ('2026-10-27T11:59:00+08:00',400),
    ('2026-11-10T10:01:00+08:00',400),
    ('2026-10-27T09:00:00+08:00',400),
    ('2026-10-27T13:00:00',400),
    ('2026-10-27T13:00:01+08:00',400),
    ('2026-10-27T13:00:00.1+08:00',400),
    ('invalid',400),
    ('2026-10-27T05:00:00Z',200),
])
def test_scheduled_time_window_timezone_and_minute_precision(schedule_clock,stamp,status):
    schedule_seed();asset=upload().json()
    response=schedule_queue(asset['id'],scheduledAt=stamp)
    assert response.status_code==status
    if status==200:
        publication=response.json()['publication'];command=response.json()['command']
        assert publication['publishMode']=='scheduled'
        assert publication['scheduledAt'].endswith('+08:00')
        assert type(publication['scheduledTimestamp']) is int
        assert command['payload']['scheduledTimestamp']==publication['scheduledTimestamp']


def test_schedule_capability_is_required_and_exposed(schedule_clock):
    schedule_seed(False);asset=upload().json()
    assert client.get('/api/video-publications/capabilities').json()['accounts'][0]['supportsScheduled'] is False
    assert schedule_queue(asset['id']).json()['detail']=='DESKTOP_VIDEO_SCHEDULE_UPGRADE_REQUIRED'
    schedule_seed(True)
    assert client.get('/api/video-publications/capabilities').json()['accounts'][0]['supportsScheduled'] is True
    assert schedule_queue(asset['id']).status_code==200


def test_schedule_title_and_time_are_part_of_idempotency(schedule_clock):
    schedule_seed();asset=upload().json()
    first=schedule_queue(asset['id'])
    assert first.status_code==200
    assert schedule_queue(asset['id']).json()['deduplicated'] is True
    assert schedule_queue(asset['id'],title='另一个标题').status_code==409
    assert schedule_queue(asset['id'],scheduledAt='2026-10-27T14:00:00+08:00').status_code==409
    assert schedule_queue(asset['id'],publishMode='immediate',scheduledAt='').status_code==409


def test_schedule_retry_retains_fields_and_revalidates_window(schedule_clock,monkeypatch):
    from datetime import timedelta
    schedule_seed();asset=upload().json();first=schedule_queue(asset['id']).json();pid=first['publication']['id']
    event(first['command']['id'],'publish_failed',{'errorMessage':'upload failed'})
    retried=client.post(f'/api/video-publications/{pid}/retry',json={'idempotencyKey':'retry-schedule'}).json()
    command=retried['command']
    assert command['payload']['title']=='独立标题'
    assert command['payload']['scheduledAt']=='2026-10-27T13:00:00+08:00'
    event(command['id'],'publish_failed',{'errorMessage':'upload failed'})
    monkeypatch.setattr(video.app_time,'now',lambda:schedule_clock+timedelta(hours=2))
    response=client.post(f'/api/video-publications/{pid}/retry',json={'idempotencyKey':'retry-too-late'})
    assert response.status_code==400 and response.json()['detail']=='VIDEO_SCHEDULE_OUT_OF_RANGE'


def test_scheduled_acceptance_waits_until_due_then_periodic_discovery(schedule_clock,monkeypatch):
    from datetime import timedelta
    from app import worker_cli
    from app.service import list_records
    schedule_seed();first=schedule_queue(upload().json()['id']).json();pid=first['publication']['id']
    result=event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True,'platformStatus':'scheduled','scheduledTimestamp':first['publication'].get('scheduledTimestamp')})
    assert result.json()['publication']['status']=='scheduled'
    assert result.json()['publication']['publicUrl']==''
    assert client.post(f'/api/video-publications/{pid}/retry',json={'idempotencyKey':'never-retry'}).status_code==409
    with SessionLocal() as db, actor_scope(None):
        _,before=worker_cli.run_scheduler_if_due(db,object(),True,None,60,now=100)
        assert before['videoPublicationDiscovery']==0
    monkeypatch.setattr(video.app_time,'now',lambda:schedule_clock+timedelta(hours=3))
    with SessionLocal() as db:
        device=get_record(db,'desktopDevices','vd');device['lastSeenAt']=video.app_time.now().isoformat();save_record(db,'desktopDevices',device)
    with SessionLocal() as db, actor_scope(None):
        _,after=worker_cli.run_scheduler_if_due(db,object(),True,100,60,now=160)
        assert after['videoPublicationDiscovery']==1
        discovery=next(c for c in list_records(db,'desktopCommands') if c['type']=='discover_publication')
        assert discovery['payload']['publishMode']=='scheduled'
        assert len([c for c in list_records(db,'desktopCommands') if c['type']=='publish_video'])==1
    pending=event(discovery['id'],'publication_discovery_succeeded',{'itemId':'123','found':False,'platformStatus':'submitted_for_review'})
    assert pending.json()['publication']['status']=='scheduled'


def test_schedule_capability_registration_and_heartbeat():
    registered=client.post('/api/desktop-devices/register',json={'deviceName':'schedule','capabilities':{'publish_video_v1':True,'publish_video_schedule_v1':True}}).json()
    did=registered['device']['id']
    assert registered['device']['capabilities']['publish_video_schedule_v1'] is True
    response=client.post('/api/desktop-events',headers={'x-device-id':did,'x-device-token':registered['deviceToken']},json={'type':'heartbeat','payload':{'capabilities':{'publish_video_v1':True,'publish_video_schedule_v1':False}}})
    assert response.status_code==200
    with SessionLocal() as db:
        assert get_record(db,'desktopDevices',did)['capabilities']['publish_video_schedule_v1'] is False

@pytest.mark.parametrize('actual',[None,1793077260,1793077200.0,'1793077200'],ids=['missing','wrong-minute','float','string'])
def test_scheduled_acceptance_requires_exact_integer_platform_time(schedule_clock,actual):
    schedule_seed();first=schedule_queue(upload().json()['id']).json()
    payload={'itemId':'123','submissionAccepted':True,'platformStatus':'scheduled'}
    if actual is not None: payload['scheduledTimestamp']=actual
    response=event(first['command']['id'],'publish_succeeded',payload).json()
    assert response['publication']['status']=='submission_unknown'
    assert response['publication']['itemId']=='123'
    assert response['publication']['publicUrl']==''


def test_scheduled_idempotent_read_survives_elapsed_window(schedule_clock,monkeypatch):
    from datetime import timedelta
    schedule_seed();asset=upload().json();first=schedule_queue(asset['id']).json()
    monkeypatch.setattr(video.app_time,'now',lambda:schedule_clock+timedelta(hours=4))
    replay=schedule_queue(asset['id'])
    assert replay.status_code==200
    assert replay.json()['deduplicated'] is True
    assert replay.json()['command']['id']==first['command']['id']


def test_immediate_mode_rejects_schedule_and_unknown_mode():
    seed();asset=upload().json()
    assert schedule_queue(asset['id'],publishMode='immediate').json()['detail']=='VIDEO_SCHEDULE_UNEXPECTED'
    assert schedule_queue(asset['id'],publishMode='later').json()['detail']=='VIDEO_PUBLISH_MODE_INVALID'


def test_scheduled_publication_still_requires_dual_public_evidence(schedule_clock):
    schedule_seed();first=schedule_queue(upload().json()['id']).json();pid=first['publication']['id']
    event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True,'platformStatus':'scheduled','scheduledTimestamp':first['publication']['scheduledTimestamp']})
    command=client.post(f'/api/video-publications/{pid}/discover').json()['command']
    result=event(command['id'],'publication_discovery_succeeded',{'itemId':'123','found':True,'platformStatus':'published','publicUrl':'https://www.douyin.com/video/123'})
    assert result.json()['publication']['status']=='scheduled'
    command=client.post(f'/api/video-publications/{pid}/discover').json()['command']
    result=event(command['id'],'publication_discovery_succeeded',{'itemId':'123','found':True,'platformStatus':'published','publicUrl':'https://www.douyin.com/video/123','publicationEvidence':{'workListVerified':True,'detailVerified':True}})
    assert result.json()['publication']['status']=='published'

def test_schedule_discovery_echo_cannot_promote_unknown(schedule_clock):
    schedule_seed();first=schedule_queue(upload().json()['id']).json();pid=first['publication']['id']
    result=event(first['command']['id'],'publish_succeeded',{'itemId':'123','submissionAccepted':True,'platformStatus':'scheduled'})
    assert result.json()['publication']['status']=='submission_unknown'
    command=client.post(f'/api/video-publications/{pid}/discover').json()['command']
    result=event(command['id'],'publication_discovery_succeeded',{'itemId':'123','found':False,'platformStatus':'scheduled','scheduledTimestamp':first['publication']['scheduledTimestamp']})
    assert result.json()['publication']['status']=='submission_unknown'
    assert result.json()['publication']['publicUrl']==''

def test_downgraded_device_cannot_claim_already_queued_scheduled_command(schedule_clock):
    schedule_seed();first=schedule_queue(upload().json()['id']).json();cid=first['command']['id']
    with SessionLocal() as db:
        device=get_record(db,'desktopDevices','vd');device['capabilities']['publish_video_schedule_v1']=False;save_record(db,'desktopDevices',device)
    headers={'x-device-id':'vd','x-device-token':'token'}
    listed=client.get('/api/desktop-commands',headers=headers)
    assert listed.status_code==200
    assert all(command['id']!=cid for command in listed.json())
    assert client.get(f'/api/desktop-commands/{cid}',headers=headers).status_code==409
    assert event(cid,'running',{}).status_code==409
    assert event(cid,'publish_progress',{'stage':'submitting'}).status_code==409
    with SessionLocal() as db:
        device=get_record(db,'desktopDevices','vd');device['capabilities']['publish_video_schedule_v1']=True;save_record(db,'desktopDevices',device)
    assert any(command['id']==cid for command in client.get('/api/desktop-commands',headers=headers).json())

@pytest.mark.parametrize('event_type',['accepted','running','publish_started'])
def test_schedule_claim_requires_current_execution_capability_not_stale_device_record(schedule_clock,event_type):
    schedule_seed();first=schedule_queue(upload().json()['id']).json();cid=first['command']['id']
    # The database still advertises a new agent, but the caller may have downgraded.
    assert event(cid,event_type,{}).status_code==409
    assert event(cid,event_type,{'executionCapabilities':{'publish_video_v1':True,'publish_video_schedule_v1':True}}).status_code==200
    # A replayed result never invokes another submission and remains recordable.
    response=event(cid,'publish_succeeded',{'itemId':'123','submissionAccepted':True,'platformStatus':'scheduled','scheduledTimestamp':first['publication']['scheduledTimestamp']})
    assert response.status_code==200 and response.json()['publication']['status']=='scheduled'
