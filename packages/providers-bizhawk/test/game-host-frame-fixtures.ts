import {createHash,randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {GAME_HOST_PROTOCOL,gameHostDigest} from '@lifestream/contracts/game-host';
import {observe,observed} from './game-host-fixtures.ts';
export function framePng(padding=0):Buffer{
 const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4);tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(padding?[chunk('tEXt',Buffer.alloc(padding))]:[]),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);
}
export function frameResult(request:ReturnType<typeof observe>,png:Buffer,now=Date.now()){
 const result=observed(request),observation=result.outcome.payload!.observation,shot=observation.screenshots[0]!;
 observation.capturedAt=observation.receivedAt=new Date(now).toISOString();shot.mediaRef=shot.screenshotId;shot.capturedAt=observation.capturedAt;shot.expiresAt=new Date(now+5000).toISOString();shot.byteLength=png.length;shot.width=shot.height=1;shot.sha256=createHash('sha256').update(png).digest('hex');
 return result;
}
export function frameFixture(padding=0){
 const request=observe(),png=framePng(padding),result=frameResult(request,png);
 const command={protocol:GAME_HOST_PROTOCOL,kind:'command' as const,attachmentId:randomUUID(),commandId:randomUUID(),requestDigest:gameHostDigest(request),expiresAt:request.deadlineAt,request};
 const attach={protocol:GAME_HOST_PROTOCOL,hostId:randomUUID(),scope:request.scope,pinsDigest:request.payload.expectedPinsDigest,providerRef:result.providerRef,sourceRevision:'b'.repeat(64)};
 return {request,png,result,command,attach};
}
