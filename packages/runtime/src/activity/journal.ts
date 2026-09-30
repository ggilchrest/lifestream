import {campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type {CampaignJournal,CampaignJournalRef} from '@lifestream/contracts/game-activity';
export type CampaignContextSelection={status:'selected'|'unavailable';reason:'selected'|'sourceChanged'|'invalidJournal'|'budgetExceeded';ref:CampaignJournalRef|null;content:string|null;entryIds:string[];goalIds:string[];isCurrent:()=>boolean};
/** Materialize within an existing conversation section. No action is executable
 * from this text, and a game binding still needs fresh save/view reconciliation. */
export function selectCampaignContext(input:CampaignJournal,maximumBytes:number,now:number,boundaryCurrent:()=>boolean):CampaignContextSelection{
 const unavailable=(reason:CampaignContextSelection['reason']):CampaignContextSelection=>({status:'unavailable',reason,ref:null,content:null,entryIds:[],goalIds:[],isCurrent:()=>false});
 const journal=campaignJournalSnapshot(input,now);if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>262144||!journal)return unavailable('invalidJournal');
 let current=false;try{current=boundaryCurrent();}catch{}if(!current)return unavailable('sourceChanged');
 // The core has no semantic contradiction/relevance oracle. Preserve the whole
 // already compact journal rather than hiding an uncited contrary story clue.
 const goals=journal.goals,entries=journal.entries;
 // Never truncate a sourced summary or drop a contrary/unfinished goal merely
 // to fit. Explicit omission is safer than inventing a compact replacement.
 const content=JSON.stringify({sourceKind:'campaignJournal',untrusted:true,limitations:['Historical continuity; current game/save reconciliation is separately required.','Goals and next steps are planning context, not executable commands.'],campaignId:journal.campaignId,journalId:journal.journalId,revision:journal.revision,accessRevision:journal.accessRevision,summary:journal.summary,summaryEntryIds:journal.summaryEntryIds,entries,goals});
 if(Buffer.byteLength(content)>maximumBytes)return unavailable('budgetExceeded');
 let retired=false;const isCurrent=()=>{try{if(retired||!boundaryCurrent()){retired=true;return false;}return true;}catch{retired=true;return false;}};
 if(!isCurrent())return unavailable('sourceChanged');
 return {status:'selected',reason:'selected',ref:{campaignId:journal.campaignId,journalId:journal.journalId,revision:journal.revision,accessRevision:journal.accessRevision},content,entryIds:entries.map(entry=>entry.entryId),goalIds:goals.map(goal=>goal.goalId),isCurrent};
}
