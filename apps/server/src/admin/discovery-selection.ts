import type {UnderstandingRepository,UnderstandingScope} from '@lifestream/storage-sqlite';
import {selectPreparedEnrichment} from '@lifestream/runtime/understanding/selection';
import type {CompiledRelationshipContext} from '@lifestream/runtime/context';

export type DiscoverySelectionSettings={enabled:boolean;budget:Record<string,number>};
/** The same bounded lookup and correction policy serve ordinary requests and isolated Lab. */
export function selectDiscoveryContext(options:{repository:UnderstandingRepository;scope:UnderstandingScope;boundary:string;input:string;audience:'authenticatedSession'|'unknown';remainingBytes:number;settings:DiscoverySelectionSettings|undefined;current:()=>boolean;recent?:(id:string)=>boolean}) {
 const start=performance.now(),{settings}=options;
 const enabled=!!settings?.enabled&&options.audience==='authenticatedSession'&&!/\b(?:actually|instead|not|never|correction|stop)\b|don't|no longer/iu.test(options.input);
 const budget={tokens:Math.max(0,Math.min(settings?.budget.enrichmentTokens??0,options.remainingBytes-1)),items:settings?.budget.selectedItems??0,deadlineMs:settings?.budget.optionalSelectionDeadlineMs??10};
 let candidates:ReturnType<UnderstandingRepository['select']>=[];
 try {if(enabled)candidates=options.repository.select(options.scope,options.boundary,options.input).filter(item=>!options.recent?.(item.id));}catch{/* Optional lookup failure leaves ordinary context available. */}
 const selected=selectPreparedEnrichment({candidates,enabled,budget,boundaryCurrent:options.current,now:()=>performance.now()});
 if(performance.now()-start>=budget.deadlineMs)return {...selected,items:[],content:'',tokenUpperBound:0,freshUntil:Date.now(),disposition:'deadline' as const};
 return {...selected,freshUntil:Math.min(Date.now()+120000,...candidates.filter(item=>selected.items.some(chosen=>chosen.id===item.id)).map(item=>item.freshUntil))};
}
export function appendDiscoveryContext(view:CompiledRelationshipContext,enrichment:ReturnType<typeof selectDiscoveryContext>):void {
 if(!enrichment.content)return;
 view.discoveryContent=enrichment.content;view.budget.usedBytes+=Buffer.byteLength(enrichment.content)+1;
 view.sourceRevisions=[...view.sourceRevisions,...enrichment.items.map(item=>item.id)];
 view.selections=[...view.selections,...enrichment.items.map(item=>({id:item.id,revision:1,sourceFamily:'prepared-discovery-candidate',lane:'relevant' as const,byteContribution:Buffer.byteLength(item.content)}))];
 view.freshUntil=new Date(Math.min(Date.parse(view.freshUntil),enrichment.freshUntil)).toISOString();
}
