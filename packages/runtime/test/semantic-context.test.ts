import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileRelationshipContext,formatPreparedRelationshipContext,selectedRelationshipSources,relationshipControlDefaults,type RelationshipContextRecord} from '../src/context/builder.ts';

const now=Date.parse('2026-10-15T00:00:00Z');
const query='Should I water the plant now?';
const advice='Qualified advice: Allow damp substrate to dry before adding liquid.';
const memory=(id='meaning',content=advice):RelationshipContextRecord=>({id,content,revision:3,sourceFamily:'retained-source',status:'approved',use:'relevant',personalization:true,mention:true,memoryRecord:true});
const ref=(record:RelationshipContextRecord)=>({id:record.id,revision:record.revision});
const base={userInput:query,audienceScope:'authenticatedSession' as const,profileRevision:'profile:2',relationshipRevision:'relationship:3',configurationRevision:'configuration:4',controls:relationshipControlDefaults,now};

test('qualified selected paraphrase reaches the formatted context without any shared query words; fallback remains lexical',()=>{
 const record=memory();
 const words=(value:string)=>new Set(value.toLowerCase().match(/[a-z]{3,}/gu));
 assert.deepEqual([...words(query)].filter(word=>words(advice).has(word)),[]);
 const fallback=compileRelationshipContext({...base,records:[record]});
 assert.deepEqual(fallback.selections,[]);assert.equal(fallback.omissions[0]!.reason,'no current-task relevance');
 const view=compileRelationshipContext({...base,records:[record],semanticReferences:[ref(record)]});
 assert.match(formatPreparedRelationshipContext(view),/Allow damp substrate to dry/);
 assert.deepEqual(selectedRelationshipSources(view)!.map(source=>({id:source.id,revision:source.revision})),[ref(record)]);
 assert.equal(view.preparationCount,1);assert.equal(view.compilerRevision,'relationship-context:11');
 assert.doesNotMatch(formatPreparedRelationshipContext(view),/rich-archive recall is unavailable/);
 assert.match(formatPreparedRelationshipContext(view),/unverified/);
});

test('explicit selection is closed over exact marked memory revisions and does not admit unselected lexical hits',()=>{
 const selected=memory(),other=memory('literal','water plant'),ordinary={...memory('ordinary','water plant'),memoryRecord:false};
 const view=compileRelationshipContext({...base,records:[selected,other,ordinary],controls:{...relationshipControlDefaults,callbackFrequency:1},semanticReferences:[ref(selected)]});
 assert.deepEqual(view.relevantContext.map(record=>record.id),[selected.id,ordinary.id]);
 assert.equal(view.omissions.find(record=>record.id===other.id)?.reason,'not selected by semantic recall');
 assert.deepEqual(compileRelationshipContext({...base,records:[other],semanticReferences:[]}).selections,[]);
 for(const references of [[{id:'foreign',revision:3}],[{id:selected.id,revision:2}],[ref(selected),ref(selected)],[{id:selected.id,revision:3,extra:true}],[{id:selected.id,revision:NaN}],[{id:ordinary.id,revision:3}],null,Array(1),Array.from({length:101},()=>ref(selected))]){
  assert.throws(()=>compileRelationshipContext({...base,records:[selected,ordinary],semanticReferences:references as never}),/semantic memory reference/i);
 }
 assert.throws(()=>compileRelationshipContext({...base,records:[],semanticReferences:[ref(selected)]}),/semantic memory reference/i,'deleted records cannot be reconstructed from a reference');
 assert.throws(()=>compileRelationshipContext({...base,records:[selected,{...selected}],semanticReferences:[ref(selected)]}),/semantic memory reference/i,'ambiguous inventories cannot qualify a reference');
});

test('semantic relevance never overrides audience, lifecycle, source expiry or per-record use exclusions',()=>{
 const record=memory();
 for(const [patch,reason] of [
  [{status:'deleted'},'lifecycle deleted'],[{personalization:false},'personalization use excluded'],[{mention:false},'mention restriction cannot establish confidentiality; withheld before inference'],[{expiresAt:new Date(now).toISOString()},'source retention expired'],[{expiresAt:'invalid'},'source retention expired'],[{content:'x'.repeat(4001)},'record exceeds bounded projection'],
 ] as const){
  const view=compileRelationshipContext({...base,records:[{...record,...patch}],semanticReferences:[ref(record)]});
  assert.deepEqual(view.selections,[]);assert.equal(view.omissions[0]!.reason,reason);
 }
 const unknown=compileRelationshipContext({...base,records:[record],audienceScope:'unknown',semanticReferences:[ref(record)]});
 assert.deepEqual(unknown.selections,[]);assert.equal(unknown.omissions[0]!.reason,'audience authorization insufficient');
 const expiresAt=new Date(now+10).toISOString(),fresh=compileRelationshipContext({...base,records:[{...record,expiresAt}],semanticReferences:[ref(record)]});
 assert.equal(fresh.freshUntil,expiresAt);
 assert.deepEqual(compileRelationshipContext({...base,now:now+10,records:[{...record,expiresAt}],semanticReferences:[ref(record)]}).selections,[]);
});

test('zero controls and nondefault lexical relevance controls remain controlling; mandatory correction survives optional selection',()=>{
 const record=memory(),correction={...memory('correction','The corrected convention remains mandatory.'),use:'correction' as const},baseline={...memory('baseline','Keep this approved baseline.'),use:'baseline' as const};
 for(const [controls,reason] of [[{personalizationIntensity:0},'personalization disabled'],[{callbackFrequency:0},'optional personal callbacks disabled']] as const){
  const view=compileRelationshipContext({...base,records:[record,correction,baseline],controls:{...relationshipControlDefaults,...controls},semanticReferences:[ref(record)]});
  assert.ok(!view.selections.some(source=>source.id===record.id));assert.equal(view.omissions.find(source=>source.id===record.id)?.reason,reason);
  assert.deepEqual(view.criticalCorrections,[correction.content]);assert.match(formatPreparedRelationshipContext(view),/corrected convention remains mandatory/);
 }
 const empty=compileRelationshipContext({...base,records:[record,correction,baseline],semanticReferences:[]});
 assert.deepEqual(empty.criticalCorrections,[correction.content]);assert.deepEqual(empty.approvedBaseline,[baseline.content]);assert.equal(empty.relevantContext.length,0);
 assert.equal(compileRelationshipContext({...base,records:[record],controls:{...relationshipControlDefaults,relevanceThreshold:1},semanticReferences:[ref(record)]}).relevantContext.length,0);
});

test('semantic choices retain model order within ordinary callback, explicit recall and UTF8 context bounds',()=>{
 const records=Array.from({length:9},(_,index)=>memory('memory-'+index));
 const semanticReferences=[...records].reverse().map(ref);
 const ordinary=compileRelationshipContext({...base,records,semanticReferences});assert.deepEqual(ordinary.relevantContext.map(record=>record.id),['memory-8']);
 const explicit=compileRelationshipContext({...base,records,semanticReferences,userInput:'What is my saved guidance?'});
 assert.deepEqual(explicit.relevantContext.map(record=>record.id),['memory-8','memory-7','memory-6','memory-5']);assert.equal(explicit.omissions.filter(source=>source.reason==='bounded allocation').length,5);
 assert.ok(explicit.budget.usedBytes<=8192);assert.ok(Buffer.byteLength(formatPreparedRelationshipContext(explicit))<=8192);
 const large=memory('large','é'.repeat(255));const bounded=compileRelationshipContext({...base,records:[large],semanticReferences:[ref(large)]});
 assert.deepEqual(bounded.selections,[]);assert.equal(bounded.omissions[0]!.reason,'bounded allocation');
 const displaced=compileRelationshipContext({...base,records:[memory()],semanticReferences:[ref(memory())]});displaced.discoveryContent='query '.repeat(74);
 assert.doesNotMatch(formatPreparedRelationshipContext(displaced),/Allow damp substrate/);assert.deepEqual(selectedRelationshipSources(displaced),[],'final source receipts reflect formatter displacement');
});

test('both representations preserve source-qualified semantic content and keep direct corrections distinct',()=>{
 const selected=memory(),correction={...memory('correction','A direct correction, not a retrieved optional preference.'),use:'correction' as const};
 for(const representation of ['recordOriented','conventionOriented'] as const){
  const view=compileRelationshipContext({...base,records:[selected,correction],representation,semanticReferences:[ref(selected)]});
  assert.match(formatPreparedRelationshipContext(view),/Allow damp substrate/);assert.deepEqual(view.criticalCorrections,[correction.content]);
  assert.deepEqual(selectedRelationshipSources(view)!.map(source=>source.id).sort(),[selected.id,correction.id].sort());
 }
});

test('an omitted lower-priority reference cannot change top-memory versus discovery allocation',()=>{
 const top=memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),tail=memory('ffffffff-ffff-4fff-8fff-ffffffffffff');
 const one=compileRelationshipContext({...base,records:[top],semanticReferences:[ref(top)]});
 const two=compileRelationshipContext({...base,records:[top,tail],semanticReferences:[ref(top),ref(tail)]});
 assert.deepEqual(two.relevantContext.map(source=>source.id),[top.id]);
 assert.equal(two.omissions.find(source=>source.id===tail.id)?.reason,'bounded allocation');
 for(const view of [one,two])view.discoveryContent='query '.repeat(74);
 assert.equal(formatPreparedRelationshipContext(one),formatPreparedRelationshipContext(two));
 assert.deepEqual(selectedRelationshipSources(one),selectedRelationshipSources(two));
 assert.match(formatPreparedRelationshipContext(two),/discovery=/);assert.doesNotMatch(formatPreparedRelationshipContext(two),/Allow damp substrate/);
});
