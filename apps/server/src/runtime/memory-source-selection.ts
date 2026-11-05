import type {RelationshipContextRecord} from '@lifestream/runtime/context';
/** Projection only. References never authorize a record: input records must
 * already come from the original scoped repository and privacy owners. */
export function selectedMemorySources(records:readonly RelationshipContextRecord[],references:readonly {id:string;revision:number}[]|undefined):RelationshipContextRecord[]{
 if(references===undefined)return [...records];
 if(!Array.isArray(references)||references.length>100)throw Error('Semantic reference bound');
 const byId=new Map(records.filter(r=>r.memoryRecord===true).map(r=>[r.id,r])),ids=new Set<string>();
 for(const ref of references){const record=byId.get(ref.id);if(!record||ids.has(ref.id)||record.revision!==ref.revision)throw Error('Semantic memory source changed');ids.add(ref.id);}
 // Mandatory approved conventions and direct corrections do not depend on an
 // optional relevance hit, including an explicitly empty semantic selection.
 return records.filter(r=>r.memoryRecord!==true||r.use!=='relevant'||ids.has(r.id));
}
