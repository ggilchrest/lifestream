import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {isDeepStrictEqual} from 'node:util';
import type {GameSaveRequest,GameSaveResult} from '@lifestream/contracts/game-activity';

const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
/** Closed supplied metadata correlation only. A digest or qualification ref
 * cannot prove native SaveRAM flush, durable readback, restart or ordinary load.
 * No save bytes, paths, emulator APIs or effect callbacks enter this helper. */
export function ordinarySaveResultMatches(rawRequest:unknown,rawResult:unknown,nowMs:number):boolean{
 const request=boundedGameDataSnapshot(rawRequest,131072) as GameSaveRequest|null,result=boundedGameDataSnapshot(rawResult,131072) as GameSaveResult|null;
 if(!request||!result||!Number.isFinite(nowMs)||!validator.validate(schema+'GameSaveRequest',request).valid||!validator.validate(schema+'GameSaveResult',result).valid||result.outcome.status!=='succeeded'||!result.outcome.payload)return false;
 const p=result.outcome.payload,s=p.saveArtifact,time=(v:string)=>Date.parse(v),issued=time(request.payload.admission.issuedAt),confirmed=time(p.confirmedAt),completed=time(result.completedAt),created=time(s.createdAt),verified=time(s.verifiedAt);
 if(result.operation!==request.operation||result.requestId!==request.requestId||result.correlationId!==request.correlationId||p.action!==request.payload.action||p.timelineId!==request.scope.timelineId||s.pinsDigest!==request.payload.expectedPinsDigest||s.artifact.byteLength<=0||created>verified||verified<issued||verified>confirmed||confirmed>completed||completed>nowMs||completed>time(request.deadlineAt)||confirmed<issued||confirmed>=time(request.payload.admission.expiresAt))return false;
 if(request.payload.action==='flushSaveRam')return s.sourceTimelineId===request.scope.timelineId;
 const expected=request.payload.saveArtifact;
 return !!expected&&expected.pinsDigest===request.payload.expectedPinsDigest&&isDeepStrictEqual(s.artifact,expected.artifact)&&s.sourceTimelineId===expected.sourceTimelineId&&s.sourceFrameNumber===expected.sourceFrameNumber&&s.createdAt===expected.createdAt&&verified>=time(expected.verifiedAt);
}
