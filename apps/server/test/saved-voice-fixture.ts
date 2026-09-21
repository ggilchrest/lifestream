import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {loadProfile} from '../src/config/loader.ts';
// Synthetic loopback service: protocol and playback proof, never voice quality.
export async function savedVoiceFixture(controls={description:true,reference:true}){
  const requests:Record<string,any>[]=[],state={fail:false,delayMs:0,ready:true,frames:1};
  const profile={...loadProfile('ai5090').ttsProfile!};
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/readyz'){res.statusCode=state.ready?200:503;return res.end(JSON.stringify({runtimeRevision:profile.runtimeVersion,modelRevision:profile.modelRevision,mappingRevision:profile.mappingRevision}));}
    if(req.url==='/v1/capabilities')return res.end(JSON.stringify({...(controls.description?{voiceDesignControl:'voxcpm.voice-design.v1'}:{}),...(controls.reference?{voiceReferenceControl:'voxcpm.voice-reference.v1'}:{})}));
    if(req.url!=='/v1/tts/synthesize'){res.statusCode=404;return res.end('{}');}
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    if(state.delayMs)await new Promise(resolve=>setTimeout(resolve,state.delayMs));if(res.destroyed)return;
    if(state.fail){res.statusCode=503;return res.end('{}');}
    const pcm=Buffer.alloc(4800*2);for(let i=0;i<4800;i++)pcm.writeInt16LE(Math.round(3000*Math.sin(i/12)),i*2);
    const reference=body.voiceReference,effectiveSynthesis={...(body.voiceDesign?{voiceDescription:body.voiceDesign.description,seed:body.voiceDesign.seed}:{}),...(reference?{referenceDigest:createHash('sha256').update(Buffer.from(reference.dataBase64,'base64')).digest('hex'),conditioningMode:reference.transcript?'continuation':'reference'}:{})};
    const events=[{kind:'preAudio',sequence:0,requestId:body.requestId,correlationId:body.correlationId,voiceBundleRevision:1,requestedDelivery:body.delivery,appliedDelivery:body.delivery,degradedDimensions:[],mappingRevision:profile.mappingRevision,effectiveSynthesis,format:body.format,runtimeRevision:profile.runtimeVersion,modelRevision:profile.modelRevision},...Array.from({length:state.frames},(_,i)=>({kind:'data',sequence:i+1,sampleOffset:i*4800,sampleCount:4800,dataBase64:pcm.toString('base64'),format:body.format})),{kind:'terminal',sequence:state.frames+1,outcome:'completed',outputSamples:4800*state.frames,frameCount:state.frames}];
    res.setHeader('content-type','application/x-ndjson');res.end(events.map(x=>JSON.stringify(x)).join('\n')+'\n');
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Fixture address unavailable');profile.endpoint=`http://127.0.0.1:${address.port}`;
  return {profile,requests,state,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
