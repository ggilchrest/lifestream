#!/usr/bin/env python3
"""LS-S029 WSL development-host verification runner."""
import argparse, base64, http.client, json, os, statistics, subprocess, threading, time, wave
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOST, PORT = "127.0.0.1", 8787
MODES = ("neutral","explanation","reassurance","concern","celebration","warning","emergency")
FORMAT = {"encoding":"pcm_s16le","sampleRateHz":48000,"channels":1}
VOICE_REVISION = 1

def utc(): return datetime.now(timezone.utc).isoformat()
def percentile(values, p):
    if not values: return None
    ordered=sorted(values); return ordered[min(len(ordered)-1,round((len(ordered)-1)*p))]

class Telemetry:
    def __init__(self, path): self.path=path; self.stop=threading.Event(); self.rows=[]
    def run(self):
        while not self.stop.is_set():
            result=subprocess.run(["nvidia-smi","--query-gpu=index,name,uuid,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw","--format=csv,noheader,nounits"],capture_output=True,text=True)
            for line in result.stdout.splitlines():
                parts=[part.strip() for part in line.split(",")]
                if len(parts)==8:
                    row={"at":utc(),"index":int(parts[0]),"name":parts[1],"uuid":parts[2],"memoryMiB":int(parts[3]),"totalMiB":int(parts[4]),"utilizationPct":int(parts[5]),"temperatureC":int(parts[6]),"powerW":float(parts[7])}
                    self.rows.append(row)
            stats=subprocess.run(["docker","stats","--no-stream","--format","{{json .}}","voxcpm2-voice"],capture_output=True,text=True)
            if stats.returncode==0 and stats.stdout.strip():
                try:
                    container=json.loads(stats.stdout)
                    self.rows.append({"at":utc(),"kind":"container","cpuPct":container.get("CPUPerc"),"memory":container.get("MemUsage"),"memoryPct":container.get("MemPerc"),"pids":container.get("PIDs")})
                except json.JSONDecodeError:
                    pass
            time.sleep(1)
        self.path.write_text("\n".join(json.dumps(row,separators=(",",":")) for row in self.rows)+"\n")

def request(mode, text, request_no, *, delivery_override=None, voice_revision=1, deadline_seconds=600, save_wav=None, cancel_after_pre=False):
    decision=f"decision-{request_no}"; interaction=f"interaction-{request_no}"
    delivery={"interactionId":interaction,"segmentId":f"segment-{request_no}","decisionId":decision,"decisionRevision":1,"deliveryMode":mode,"urgency":"critical" if mode=="emergency" else "high" if mode=="warning" else "normal","pace":.5,"energy":.5}
    if delivery_override: delivery.update(delivery_override)
    body={"protocolVersion":"voxcpm.loopback.v1","requestId":f"request-{request_no}","correlationId":decision,"interactionId":interaction,"deadlineAt":(datetime.now(timezone.utc)+timedelta(seconds=deadline_seconds)).isoformat(),"voiceBundleKey":"fixture-voice-design","voiceBundleRevision":voice_revision,"text":text,"delivery":delivery,"format":FORMAT}
    started=time.perf_counter(); connection=http.client.HTTPConnection(HOST,PORT,timeout=900)
    connection.request("POST","/v1/tts/synthesize",json.dumps(body),{"content-type":"application/json","accept":"application/x-ndjson"})
    response=connection.getresponse()
    if response.status!=200: raise AssertionError(f"HTTP {response.status}")
    events=[]; pcm=[]; first_pcm=None; pre_audio=None
    while True:
        line=response.readline()
        if not line: break
        event=json.loads(line); events.append(event)
        elapsed=(time.perf_counter()-started)*1000
        if event["kind"]=="preAudio":
            pre_audio=elapsed
            if cancel_after_pre:
                connection.close()
                return {"cancelled":True,"preAudioMs":pre_audio,"events":["preAudio"]}
        elif event["kind"]=="data":
            if first_pcm is None: first_pcm=elapsed
            pcm.append(base64.b64decode(event["dataBase64"]))
        elif event["kind"]=="terminal": break
    connection.close()
    validate(events,body)
    if save_wav and pcm:
        with wave.open(str(save_wav),"wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(48000); output.writeframes(b"".join(pcm))
    terminal=events[-1]
    return {"mode":mode,"elapsedMs":round((time.perf_counter()-started)*1000,2),"preAudioMs":round(pre_audio,2) if pre_audio else None,"firstPcmMs":round(first_pcm,2) if first_pcm else None,"frames":terminal["frameCount"],"samples":terminal["outputSamples"],"outcome":terminal["outcome"],"degradedDimensions":events[0].get("degradedDimensions",[]) if events[0]["kind"]=="preAudio" else [],"effectiveSynthesis":events[0].get("effectiveSynthesis") if events[0]["kind"]=="preAudio" else None}

def validate(events, body):
    if not events or events[-1]["kind"]!="terminal": raise AssertionError("missing terminal")
    if events[0]["kind"]=="terminal":
        if len(events)!=1: raise AssertionError("terminal-only response has extra events")
        return
    if events[0]["kind"]!="preAudio": raise AssertionError("preAudio not first")
    pre=events[0]
    if pre["requestId"]!=body["requestId"] or pre["correlationId"]!=body["correlationId"]: raise AssertionError("identity correlation")
    if pre["requestedDelivery"]!=body["delivery"]: raise AssertionError("requested delivery drift")
    offset=frames=0; terminal_count=0
    for sequence,event in enumerate(events):
        if event["sequence"]!=sequence: raise AssertionError("sequence gap")
        if event["kind"]=="data":
            raw=base64.b64decode(event["dataBase64"],validate=True)
            if event["sampleOffset"]!=offset or not 1<=event["sampleCount"]<=4800 or len(raw)!=event["sampleCount"]*2: raise AssertionError("PCM framing")
            offset+=event["sampleCount"]; frames+=1
        elif event["kind"]=="terminal":
            terminal_count+=1
            if event["outputSamples"]!=offset or event["frameCount"]!=frames: raise AssertionError("terminal counts")
    if terminal_count!=1: raise AssertionError("terminal cardinality")

def wait_ready(timeout=900):
    started=time.monotonic(); attempts=0
    while time.monotonic()-started<timeout:
        attempts+=1
        try:
            connection=http.client.HTTPConnection(HOST,PORT,timeout=3); connection.request("GET","/readyz")
            response=connection.getresponse(); payload=json.loads(response.read()); connection.close()
            if response.status==200 and payload.get("status")=="ready": return {"seconds":round(time.monotonic()-started,2),"attempts":attempts}
        except OSError: pass
        time.sleep(5)
    raise TimeoutError("readiness timeout")

def summarize_telemetry(rows):
    result={}
    for index in (0,1):
        selected=[row for row in rows if row.get("index")==index]
        if not selected: raise AssertionError(f"missing telemetry for physical GPU {index}")
        result[str(index)]={"name":selected[0]["name"],"memoryMiB":{"min":min(r["memoryMiB"] for r in selected),"max":max(r["memoryMiB"] for r in selected)},"utilizationPctMax":max(r["utilizationPct"] for r in selected),"temperatureCMax":max(r["temperatureC"] for r in selected),"powerWMax":max(r["powerW"] for r in selected)}
    if result["0"]["memoryMiB"]["max"]>1500: raise AssertionError("material VoxCPM allocation on RTX 5090")
    result["containerSamples"]=[row for row in rows if row.get("kind")=="container"][-10:]
    return result

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("phase",choices=("expressive","restart","soak"))
    parser.add_argument("--seconds",type=int,default=1800); parser.add_argument("--out",required=True)
    args=parser.parse_args(); out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    telemetry=Telemetry(out/f"{args.phase}-telemetry.ndjson"); thread=threading.Thread(target=telemetry.run,daemon=True); thread.start()
    result={"phase":args.phase,"startedAt":utc(),"isolationClaim":"WSL application-level GPU isolation","cudaVisibleDevices":"1","logicalDevice":"cuda:0"}
    try:
        if args.phase=="expressive":
            runs=[]
            for i,mode in enumerate(MODES): runs.append(request(mode,f"LS-S029 {mode} delivery verification.",f"expressive-{i}",save_wav=out/f"{mode}.wav"))
            degraded=request("unsupported","Unsupported expression must degrade before audio.","degraded",delivery_override={"pace":2,"energy":-1})
            invalid_voice=request("neutral","Invalid voice.","invalid-voice",voice_revision=99)
            expired=request("neutral","Expired.","expired",deadline_seconds=-1)
            if any(run["outcome"]!="completed" or not run["frames"] for run in runs): raise AssertionError("expressive mode did not complete with PCM")
            if degraded["outcome"]!="completed" or not degraded["degradedDimensions"]: raise AssertionError("unsupported expression did not produce typed pre-audio degradation")
            if invalid_voice["outcome"]!="unsupportedRequest": raise AssertionError("invalid voice revision was not rejected")
            if expired["outcome"]!="deadlineExceeded": raise AssertionError("expired request did not terminate as deadlineExceeded")
            result.update(runs=runs,degraded=degraded,invalidVoice=invalid_voice,expired=expired)
        elif args.phase=="restart":
            request("neutral","Pre-restart verification.","before-restart")
            subprocess.run(["docker","kill","voxcpm2-voice"],check=True,capture_output=True)
            unavailable=False
            try: wait_ready(timeout=1)
            except TimeoutError: unavailable=True
            subprocess.run(["docker","start","voxcpm2-voice"],check=True,capture_output=True)
            recovery=wait_ready(); after=request("neutral","Post-restart verification.","after-restart")
            cancelled=request("neutral","Cancellation fencing verification.","cancel",cancel_after_pre=True)
            time.sleep(2)
            post_cancel=request("neutral","Post-cancellation verification.","post-cancel")
            if not unavailable: raise AssertionError("sidecar remained ready while stopped")
            if after["outcome"]!="completed" or post_cancel["outcome"]!="completed": raise AssertionError("provider did not recover after restart/cancellation")
            result.update(unavailableWhileStopped=unavailable,recovery=recovery,after=after,cancelled=cancelled,postCancel=post_cancel)
        else:
            deadline=time.monotonic()+args.seconds; runs=[]; count=0
            texts=("Short stability check.","This medium stability request verifies repeated streaming output and bounded resource behavior.","This longer stability request exercises the provider over a representative utterance while checking contiguous audio frames, terminal counts, latency, and sustained resource stability.")
            while time.monotonic()<deadline:
                runs.append(request(MODES[count%len(MODES)],texts[count%len(texts)],f"soak-{count}"))
                count+=1
                if count%20==0:
                    request("neutral","Rapid cancellation stability probe.",f"soak-cancel-{count}",cancel_after_pre=True)
                    time.sleep(2)
            elapsed=[r["elapsedMs"] for r in runs]; first=[r["firstPcmMs"] for r in runs]
            failures=sum(r["outcome"]!="completed" for r in runs)
            if failures: raise AssertionError(f"{failures} soak synthesis requests failed")
            result.update(durationSeconds=args.seconds,requests=len(runs),cancellationProbes=count//20,failures=failures,latencyMs={"p50":percentile(elapsed,.5),"p95":percentile(elapsed,.95),"max":max(elapsed)},firstPcmMs={"p50":percentile(first,.5),"p95":percentile(first,.95),"max":max(first)},samples=sum(r["samples"] for r in runs))
    finally:
        telemetry.stop.set(); thread.join()
    result["telemetry"]=summarize_telemetry(telemetry.rows); result["finishedAt"]=utc()
    (out/f"{args.phase}-result.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps(result,indent=2))

if __name__=="__main__": main()
