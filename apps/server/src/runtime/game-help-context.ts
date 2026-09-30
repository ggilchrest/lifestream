import {createHash} from 'node:crypto';
import type {ActivityOwner,GameHelpRepository} from '@lifestream/storage-sqlite';
import type {RelationshipContextRecord} from '@lifestream/runtime/context';

export type PendingGameHelpContext=Readonly<{records:readonly RelationshipContextRecord[];revision:string;isCurrent:()=>boolean}>;
/** One bounded read of existing pending metadata. This is foreground context,
 * not Human advice, a current screen, an initiative grant or a channel result. */
export function selectPendingGameHelpContext(repository:GameHelpRepository,owner:ActivityOwner,maximumCandidates:number):PendingGameHelpContext{
 const empty=():PendingGameHelpContext=>Object.freeze({records:[],revision:'unavailable',isCurrent:()=>false});
 if(!Number.isSafeInteger(maximumCandidates)||maximumCandidates<1||maximumCandidates>4)return empty();
 const read=repository.get.bind(repository);let rows:ReturnType<GameHelpRepository['inspect']>;
 try{rows=repository.inspect(owner);}catch{return empty();}
 if(rows.length>128)return empty();
 const pending=rows.flatMap(row=>row.pending?[row.pending]:[]).slice(0,maximumCandidates);
 if(!pending.length)return empty();
 const scope=Object.freeze({...owner}),hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const fingerprints=pending.map(row=>hash(row));let retired=false,checking=false;
 const isCurrent=()=>{if(retired||checking)return false;checking=true;try{for(const [index,row]of pending.entries()){const current=read(scope,row.item.helpId);if(!current||hash(current)!==fingerprints[index]){retired=true;return false;}}return true;}catch{retired=true;return false;}finally{checking=false;}};
 const records=pending.map(row=>Object.freeze({id:'game-help:'+row.item.helpId,revision:row.revision,sourceFamily:'game-help:'+row.item.helpId,status:'approved',use:'relevant' as const,personalization:true,mention:true,gameHelp:true,expiresAt:new Date(row.expiresAt).toISOString(),content:`Queued game question (${row.item.queuedAt}, timeline=${row.item.scope.timelineId}): ${row.item.question} Recorded attempts: ${row.item.attemptsSummary} Historical simulated source; delivery/reply/image unproved. No play/resume/contact authority.`}));
 if(!isCurrent())return empty();
 return Object.freeze({records:Object.freeze(records),revision:hash(fingerprints),isCurrent});
}
