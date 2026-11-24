// SPDX-License-Identifier: Apache-2.0
// Run AFTER cap sync/package-private: that operation replaces App/public.
// Generates generic offline system speech; no voice models or private assets.
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function inspectProbeWav(data){
 if(data.length<44||data.length>2*1024*1024||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE'||data.readUInt32LE(4)!==data.length-8)throw Error('Invalid bounded WAV container.');
 let format,samples;
 for(let offset=12;offset+8<=data.length;){
  const kind=data.toString('ascii',offset,offset+4),size=data.readUInt32LE(offset+4),start=offset+8;
  if(start+size>data.length)throw Error('Truncated WAV chunk.');
  if(kind==='fmt '){if(format||size<16)throw Error('Invalid WAV format chunk.');format={encoding:data.readUInt16LE(start),channels:data.readUInt16LE(start+2),sampleRate:data.readUInt32LE(start+4),bytesPerSecond:data.readUInt32LE(start+8),alignment:data.readUInt16LE(start+12),bits:data.readUInt16LE(start+14)};}
  if(kind==='data'){if(samples!==undefined||size===0||size%2)throw Error('Invalid WAV sample data.');samples=size/2;}
  offset=start+size+(size%2);
 }
 if(!format||format.encoding!==1||format.channels!==1||format.sampleRate!==48000||format.bits!==16||format.alignment!==2||format.bytesPerSecond!==96000||!samples||samples>48000*15)throw Error('Test clip must be at most 15 seconds of 48 kHz mono PCM16.');
 return {sampleRateHz:48000,channels:1,encoding:'pcm_s16le',samples,durationSeconds:samples/48000,bytes:data.length};
}
export async function generateProbe(){
 if(process.platform!=='darwin')throw Error('Generate this offline diagnostic clip on macOS with say and afconvert.');
 const temporary=await mkdtemp(join(tmpdir(),'ls-audio-probe-'));
 try{
  const input=join(temporary,'probe.aiff'),output=join(temporary,'probe.wav');
  for(const [command,args] of [
   ['/usr/bin/say',['-v','Samantha','-r','160','-o',input,'This is a local audio test. Listen for a clear voice, smooth pauses, and a steady ending. One, two, three, four, five.']],
   ['/usr/bin/afconvert',['-f','WAVE','-d','LEI16@48000','-c','1',input,output]],
  ]){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});if(result.status!==0)throw Error(`${command} could not generate the offline test clip.`);}
  const data=await readFile(output),metadata=inspectProbeWav(data),destination=new URL('../ios/App/App/public/audio-probe.wav',import.meta.url);
  await mkdir(new URL('.',destination),{recursive:true});await writeFile(destination,data);
  return {...metadata,path:destination.pathname};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await generateProbe()));
