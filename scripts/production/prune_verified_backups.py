#!/usr/bin/env python3
"""Prune only complete, >7-day backups after a new verified backup exists."""
import argparse,datetime,json,re,shutil,subprocess
from pathlib import Path

def valid_payloads(p):
    if subprocess.run(['gzip','-t',str(p/'uploads.tar.gz')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode: return False
    with (p/'database.dump').open('rb') as f:
        return subprocess.run(['docker','exec','-i','zhixin-ai-production-postgres-1','pg_restore','--list'],stdin=f,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0

def candidates(root, now, validate=valid_payloads):
    root=root.resolve(strict=True)
    complete=[]
    for p in root.iterdir():
        if p.is_symlink() or not p.is_dir() or not re.fullmatch(r"[0-9]{8}-[0-9]{6}",p.name): continue
        if p.resolve().parent!=root: continue
        required=['database.dump','uploads.tar.gz','env.production','docker-compose.prod.yml']
        if not all((p/n).is_file() and not (p/n).is_symlink() and (p/n).stat().st_size>0 for n in required): continue
        if validate(p): complete.append(p)
    complete.sort(key=lambda p:p.name,reverse=True)
    return [p for p in complete[7:] if now-datetime.datetime.strptime(p.name,'%Y%m%d-%H%M%S')>datetime.timedelta(days=7)]

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--verified',required=True);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    root=Path(args.root).resolve(strict=True);verified=Path(args.verified)
    if verified.is_symlink() or verified.resolve().parent!=root or not (verified/'VERIFIED').is_file(): raise SystemExit('verified current backup required')
    stamp=datetime.datetime.strptime(verified.name,'%Y%m%d-%H%M%S')
    if stamp.date()!=datetime.datetime.now().date(): raise SystemExit('must verify today backup before pruning')
    targets=candidates(root,datetime.datetime.now());print(json.dumps({'delete':[p.name for p in targets],'apply':args.apply}))
    if args.apply:
        for p in targets:
            if p.is_symlink() or p.resolve().parent!=root: raise SystemExit('unsafe backup path')
            shutil.rmtree(p)
