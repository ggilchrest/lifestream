"""Host-loopback diagnosis; exact original corpus, no inference or physical I/O."""
import argparse,base64,json,time,threading,urllib.request,traceback
from datetime import datetime,timezone
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--port',type=int,default=8787);args=parser.parse_args()
root=Path(args.output);root.mkdir(parents=True,exist_ok=False)
text='The package will arrive tomorrow. Please leave it beside the front door. The garden is quiet this evening. We can take a short walk after dinner. Bring a jacket if the air feels cool. I will meet you outside.'
report={'status':'inProgress','text':text,'deadlineMs':60000,'segmentDeadlineMs':45000,'cases':[],'health':[]};stop=threading.Event()
def save(): (root/'result.json').write_text(json.dumps(report,indent=2))
def health():
    while not stop.wait(2):
        start=time.monotonic()
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/healthz',timeout=1) as response: state=json.load(response)
            report['health'].append({'elapsedMs':(time.monotonic()-start)*1000,'state':state})
        except Exception as e: report['health'].append({'error':repr(e),'elapsedMs':(time.monotonic()-start)*1000})
thread=threading.Thread(target=health,daemon=True);thread.start();save()
try:
    for mode,parts in [('monolithic',[text]),('segmented',[s.strip()+'.' for s in text.split('.') if s.strip()])]:
        start=time.monotonic();wall=time.time();samples=0;first=None;last=None;gap=0
        case={'mode':mode,'status':'inProgress','samples':0};report['cases'].append(case);save()
        with (root/(mode+'.pcm')).open('wb') as pcm,(root/(mode+'.events.ndjson')).open('w') as events:
            for index,part in enumerate(parts):
                remaining=60-(time.monotonic()-start)
                if remaining<=0: raise TimeoutError('original total 60 second deadline')
                deadline=datetime.fromtimestamp(time.time()+min(remaining,45),timezone.utc).isoformat()
                request={'protocolVersion':'voxcpm.loopback.v1','requestId':f'{mode}-{index}','correlationId':mode,'interactionId':mode,'deadlineAt':deadline,'voiceBundleKey':'fixture-voice-design','voiceBundleRevision':1,'text':part,'delivery':{'interactionId':mode,'segmentId':str(index),'decisionId':mode,'decisionRevision':1,'deliveryMode':'reassurance','urgency':'normal','pace':.5,'energy':.4},'format':{'encoding':'pcm_s16le','sampleRateHz':48000,'channels':1},'voiceDesign':{'version':'voxcpm.voice-design.v1','description':'A warm clear adult voice','seed':42}}
                terminal=None
                with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{args.port}/v1/tts/synthesize',json.dumps(request).encode(),{'Content-Type':'application/json'}),timeout=min(remaining,45)) as response:
                    for line in response:
                        event=json.loads(line);elapsed=(time.monotonic()-start)*1000
                        if event['kind']=='data':
                            raw=base64.b64decode(event.pop('dataBase64'));pcm.write(raw);pcm.flush();samples+=len(raw)//2
                            first=elapsed if first is None else first
                            if last is not None:gap=max(gap,elapsed-last)
                            last=elapsed
                        if event['kind']=='terminal':terminal=event
                        events.write(json.dumps({'elapsedMs':elapsed,'wallElapsedMs':(time.time()-wall)*1000,**event})+'\n');events.flush()
                        case.update(samples=samples,audioSeconds=samples/48000,firstPcmMs=first,maxPacketGapMs=gap,elapsedMs=elapsed);save()
                if not terminal or terminal['outcome']!='completed':raise RuntimeError(str(terminal))
        case.update(status='completed',rtf=(time.monotonic()-start)/(samples/48000));save()
    report['status']='completed'
except BaseException as error:report.update(status='failed',error=repr(error),traceback=traceback.format_exc());raise
finally:stop.set();thread.join(2);save()
