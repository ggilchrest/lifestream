"""Opt-in host diagnostic; service must be stopped before loading this model.

Run in the existing image with its exact model mount and GPU isolation. Outputs
are private incremental PCM/JSON, never a production or listening acceptance.
"""
import argparse, importlib.util, json, os, time, traceback
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True)
parser.add_argument('--sidecar',default='/app/voxcpm_sidecar.py')
parser.add_argument('--eager',action='store_true')
args=parser.parse_args()
root=Path(args.output);root.mkdir(parents=True,exist_ok=False)
report={'status':'inProgress','compile':not args.eager,'cases':[]}
def save(): (root/'result.json').write_text(json.dumps(report,indent=2))
save()
try:
    import torch, numpy as np
    spec=importlib.util.spec_from_file_location('sidecar',args.sidecar)
    sidecar=importlib.util.module_from_spec(spec);spec.loader.exec_module(sidecar)
    assert torch.cuda.device_count()==1 and 'RTX 3080' in torch.cuda.get_device_name(0)
    from voxcpm import VoxCPM
    start=time.monotonic()
    sidecar.MODEL=VoxCPM.from_pretrained(os.environ['VOXCPM_MODEL_PATH'],load_denoiser=False,optimize=not args.eager)
    report.update(loadSeconds=time.monotonic()-start,device=torch.cuda.get_device_name(0),runtime=sidecar.RUNTIME_REVISION,model=sidecar.MODEL_REVISION)
    # Exact failed request and exact mapped voice/settings, no HTTP or adapter.
    text='The package will arrive tomorrow. Please leave it beside the front door. The garden is quiet this evening. We can take a short walk after dinner. Bring a jacket if the air feels cool. I will meet you outside.'
    style='A warm clear adult voice; A warm, calm adult voice with a reassuring tone'
    for name,parts in [('original-monolithic',[text]),('original-segmented',[sentence.strip()+'.' for sentence in text.split('.') if sentence.strip()])]:
        case={'name':name,'text':text,'style':style,'seed':42,'cfg':2,'steps':10,'maxTokens':375,'samples':0,'firstPcmMs':None,'maxYieldGapMs':0,'status':'inProgress'}
        report['cases'].append(case);save()
        start=time.monotonic();wall=time.time();last=None
        torch.cuda.reset_peak_memory_stats()
        with (root/(name+'.pcm')).open('wb') as pcm, (root/(name+'.events.ndjson')).open('w') as events:
            for part in parts:
                generator=sidecar.generate_audio(part,style,42)
                try:
                    for chunk in generator:
                        elapsed=(time.monotonic()-start)*1000
                        assert np.isfinite(chunk).all()
                        pcm.write((np.clip(chunk,-1,1)*32767).astype('<i2').tobytes());pcm.flush()
                        case['firstPcmMs']=elapsed if case['firstPcmMs'] is None else case['firstPcmMs']
                        if last is not None: case['maxYieldGapMs']=max(case['maxYieldGapMs'],elapsed-last)
                        last=elapsed;case['samples']+=len(chunk)
                        case.update(elapsedMs=elapsed,wallElapsedMs=(time.time()-wall)*1000,peakAllocated=torch.cuda.max_memory_allocated(),peakReserved=torch.cuda.max_memory_reserved(),audioSeconds=case['samples']/48000)
                        events.write(json.dumps(case)+'\n');events.flush();save()
                        if elapsed>120000: raise TimeoutError('120 second diagnostic ceiling at model safe yield')
                finally: generator.close()
        case.update(status='completed',elapsedMs=(time.monotonic()-start)*1000,wallElapsedMs=(time.time()-wall)*1000)
        case['rtf']=case['elapsedMs']/1000/case['audioSeconds'];save()
    report['status']='completed'
except BaseException as error:
    report.update(status='failed',error=repr(error),traceback=traceback.format_exc());raise
finally: save()
