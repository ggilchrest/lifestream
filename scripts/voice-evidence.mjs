import {appendFileSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Diagnostic artifacts are private and incremental: an assertion must not
// erase the last successful PCM/event or turn a failed run into no report.
export class VoiceEvidence {
  constructor(name, root = process.env.LIFESTREAM_VOICE_ARTIFACTS || join(homedir(), '.cache/lifestream/voice-stabilization')) {
    mkdirSync(root, {recursive:true, mode:0o700});
    this.directory=mkdtempSync(join(root, `${name}-`));
    this.cases=[];
    this.started=performance.now();
    this.finish('inProgress');
  }
  startCase(name, configuration) {
    const record={name,configuration,started:performance.now(),startedWall:Date.now(),samples:0,frames:0,firstPcmMs:null,lastPcmMs:null,maxPacketGapMs:0,outcome:'inProgress'};
    this.cases.push(record);this.finish('inProgress');return record;
  }
  event(record, event) {
    const elapsedMs=performance.now()-record.started;
    const {frame,...summary}=event;
    appendFileSync(join(this.directory, `${record.name}.events.ndjson`),JSON.stringify({elapsedMs,...summary,...(frame?{frame:{...frame,dataBase64:undefined}}:{})})+'\n',{mode:0o600});
    if(event.kind==='data') {
      const pcm=Buffer.from(frame.dataBase64,'base64');
      // Keep even a malformed partial for diagnosis, but never certify it.
      appendFileSync(join(this.directory, `${record.name}.pcm`),pcm,{mode:0o600});
      if(pcm.length!==frame.sampleCount*2||frame.sampleOffset!==record.samples)throw new Error('diagnostic PCM accounting mismatch');
      record.firstPcmMs??=elapsedMs;
      if(record.lastPcmMs!==null)record.maxPacketGapMs=Math.max(record.maxPacketGapMs,elapsedMs-record.lastPcmMs);
      record.lastPcmMs=elapsedMs;record.samples+=frame.sampleCount;record.frames++;
      record.sampleRateHz=frame.format?.sampleRateHz??48000;
    }
    if(event.kind==='terminal'){record.outcome=event.outcome;record.terminal=event;record.completedMs=elapsedMs;record.wallElapsedMs=Date.now()-record.startedWall;}
    this.finish('inProgress');
  }
  finish(outcome,error) {
    const report={outcome,error:error?{name:error.name,message:error.message}:null,elapsedMs:performance.now()-this.started,cases:this.cases.map(({started,...record})=>({...record,elapsedMs:record.completedMs??performance.now()-started,audioSeconds:record.samples/(record.sampleRateHz??48000),rtf:record.samples?(record.completedMs??performance.now()-started)/1000/(record.samples/(record.sampleRateHz??48000)):null,firstPcmMs:record.firstPcmMs}))};
    writeFileSync(join(this.directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    return report;
  }
}
