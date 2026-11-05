import {createConnection} from 'node:net';
import {openSync,closeSync,lstatSync,fstatSync,constants} from 'node:fs';
import {join} from 'node:path';

export function ownedGameMediaAvailable(directory:string):boolean{
 try{const s=lstatSync(join(directory,'media.sock'));return s.isSocket()&&s.uid===process.getuid!()&&(s.mode&0o777)===0o600;}catch{return false;}
}
/** Independent read-only media lane, pinned to the original owned process.
 * The filesystem address and invocation never leave this host-side adapter. */
export async function* openOwnedGameMedia(options:{directory:string;runId:string;pinsDigest:string;invocation:string;current:()=>boolean;signal:AbortSignal}):AsyncGenerator<Buffer>{
 const {signal}=options;signal.throwIfAborted();if(!options.current()||!ownedGameMediaAvailable(options.directory))throw Error('Owned game media unavailable');
 const fd=openSync(options.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),identity=fstatSync(fd),path='/proc/self/fd/'+fd+'/media.sock';
 const parentCurrent=()=>{const named=lstatSync(options.directory),opened=fstatSync(fd);return [named,opened].every(s=>s.isDirectory()&&s.dev===identity.dev&&s.ino===identity.ino&&s.uid===process.getuid!()&&(s.mode&0o777)===0o700);};
 if(!parentCurrent()){closeSync(fd);throw Error('Owned media directory changed');}
 const socket=createConnection({path}),abort=()=>socket.destroy();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();let pending=Buffer.alloc(0),metadata=false;
 try{
  for await(const raw of socket){
   signal.throwIfAborted();if(!parentCurrent())throw Error('Owned game media scope ended');
   pending=Buffer.concat([pending,raw]);if(pending.length>2162693)throw Error('Game media queue bound');
   while(pending.length>=5){
    const length=pending.readUInt32BE(0);if(length<2||length>2097153)throw Error('Game media packet bound');if(pending.length<4+length)break;
    const packet=pending.subarray(4,4+length),kind=packet[0]!,payload=packet.subarray(1);pending=pending.subarray(4+length);
    // One fresh owner/access check before each forwarded packet. No cached
    // authority crosses a yield; raw fragmentation needs no second graph walk.
    if(!options.current())throw Error('Owned game media scope ended');
    if(!metadata){
     if(kind!==1||payload.length>4096)throw Error('Game media identity unavailable');const value=JSON.parse(payload.toString('utf8'));
     if(value.schemaVersion!=='ct-live-media/1'||value.runId!==options.runId||value.pinsDigest!==options.pinsDigest||value.invocation!==options.invocation||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<256||value.width>1280||value.height<224||value.height>720||value.sampleRate!==48000||value.channels!==2)throw Error('Game media identity changed');
     const body=Buffer.from(JSON.stringify({schemaVersion:value.schemaVersion,runId:value.runId,width:value.width,height:value.height,sampleRate:48000,channels:2})),header=Buffer.alloc(5);header.writeUInt32BE(body.length+1);header[4]=1;metadata=true;yield Buffer.concat([header,body]);
    }else{
     if(kind===2){if(payload.length<4||payload[0]!==255||payload[1]!==216||payload.at(-2)!==255||payload.at(-1)!==217)throw Error('Game media JPEG unavailable');}
     else if(kind===3){if(payload.length>4096)throw Error('Game media audio bound');}else throw Error('Game media type unavailable');
     const header=Buffer.alloc(4);header.writeUInt32BE(length);yield Buffer.concat([header,packet]);
    }
   }
  }
  if(!metadata||pending.length)throw Error('Game media truncated');
 }finally{signal.removeEventListener('abort',abort);socket.destroy();closeSync(fd);}
}
