#!/usr/bin/env python3
"""Synthetic same-harness file handoff; prints no fixture contents or credentials."""
import base64, json, os, pathlib, subprocess, sys, tempfile, uuid
ROOTS={'r3':'/srv/lifestream/workspace/mobile-context-a-source-20261029/joined-native-host-actual-r3','lost':'/srv/lifestream/workspace/mobile-context-a-source-20261029/joined-native-host-lost-response'}
if len(sys.argv) not in (5,6) or sys.argv[1] not in ('publish','fetch'):
    raise SystemExit('usage: helper publish|fetch local-directory command-number operation')
mode, directory, number, operation=sys.argv[1:5]; which=sys.argv[5] if len(sys.argv)==6 else 'r3'; ROOT=ROOTS[which]; local=pathlib.Path(directory); n=int(number)
if n<1 or n>99 or operation not in {'inspect','seedRecords','armReceiptFailure','completePending','freshSelf','seedCapacity','finish'}:
    raise SystemExit('invalid command')
seed=json.loads((local/'host-seed.json').read_text()); run=seed['fixtureRunId']
if seed.get('syntheticOnly') is not True or not isinstance(run,str) or not run:
    raise SystemExit('invalid synthetic seed')
name=f'host-command-{n}.json'; destination=local/name
if mode=='publish':
    if destination.exists(): raise SystemExit('local command already exists; no retry')
    command={'fixtureRunId':run,'commandId':n,'operation':operation}
    if operation=='seedRecords':
        response=json.loads((local/'configure-response.json').read_text()); command.update(enrollmentId=response['result']['receipt']['result']['enrollment']['enrollmentId'],count=1)
    if operation=='completePending':
        journal=json.loads((local/'remove-journal.json').read_text()); command['request']=json.loads(base64.b64decode(journal['original'],validate=True))
    data=(json.dumps(command,separators=(',',':'))+'\n').encode();fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data)
    partial=f'{ROOT}/{name}.{uuid.uuid4().hex}.partial';final=f'{ROOT}/{name}'
    subprocess.run(['scp','-q',str(destination),f'lifestream:{partial}'],check=True)
    code='import os,sys;os.link(sys.argv[1],sys.argv[2]);os.unlink(sys.argv[1])'
    subprocess.run(['ssh','-o','BatchMode=yes','lifestream','python3','-c',repr(code),partial,final],check=True)
    print('synthetic command published atomically')
else:
    final=local/f'host-command-{n}-result.json'
    if final.exists():raise SystemExit('result already retained')
    fd,tmp=tempfile.mkstemp(prefix=f'.result-{n}-',dir=local);os.close(fd)
    try:
        subprocess.run(['scp','-q',f'lifestream:{ROOT}/host-command-{n}-result.json',tmp],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        value=json.loads(pathlib.Path(tmp).read_text())
        if value.get('fixtureRunId')!=run or value.get('commandId')!=n or value.get('operation')!=operation:raise ValueError('mismatched result')
        os.replace(tmp,final);print('synthetic command result verified')
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
