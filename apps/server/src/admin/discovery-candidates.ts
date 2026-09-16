import {favoriteSupport,favoriteMethod,type FavoriteEvidence} from './discovery-preference.ts';
import {randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import type {UnderstandingRecord} from '@lifestream/storage-sqlite';

const validator=createContractValidator();
type CandidateItem={text:string;sourceRefs:string[];claimId:string|null;kind:'discovery'|'question'|'connection';groundingRefs?:string[];limitations?:string[];alternatives?:string[];scores?:Record<string,unknown>};
const refs=(value:unknown):string[]=>Array.isArray(value)?value.filter((ref):ref is string=>typeof ref==='string'):[];
/** Build one bounded, evidence-linked connection without choosing a hypothesis as fact. */
function hypothesisConnection(parent:UnderstandingRecord,topicRefs:string[],parentRef:string):CandidateItem|undefined {
 if(topicRefs.length<2)return undefined;
 const explanations=Array.isArray(parent.explanations)?(parent.explanations as Record<string,unknown>[]):[];
 const supportRefs=[...new Set(explanations.flatMap(explanation=>refs(explanation.supportEvidenceRefs)))];
 if(supportRefs.length<2)return undefined;
 const counterRefs=[...new Set(explanations.flatMap(explanation=>refs(explanation.counterEvidenceRefs)))];
 const traitSets=explanations.map(explanation=>new Set(refs(explanation.traitRefs)));
 const commonTraits=traitSets.length?[...traitSets[0]!].filter(trait=>traitSets.every(set=>set.has(trait))):[];
 const basis=commonTraits.length?`the shared trait ${commonTraits.slice(0,3).join(', ')}`:'the evidence-linked explanations';
 const content=`A tentative connection to explore across ${topicRefs.join(' and ')} is ${basis}. Ask whether it matters in this context.`;
 const boundaries=explanations.map(explanation=>String(explanation.boundary)).filter(Boolean);
 const groundingRefs=[parentRef,...supportRefs,...counterRefs,...commonTraits];
 // Omit the whole optional candidate if the bounded record cannot preserve every
 // evidence link. Never trim support or counterevidence to fit a projection.
 if(groundingRefs.length>32||Buffer.byteLength(content)>2000)return undefined;
 return {text:content,sourceRefs:[],claimId:null,kind:'connection',groundingRefs,alternatives:explanations.map(explanation=>String(explanation.summary)),limitations:[
  'Competing explanations remain unresolved; this connection is a prompt for exploration, not a personal motive or established preference.',
  ...boundaries,
  String(parent.unknownAlternative),String(parent.uncertainty)
 ].filter((value,index,array)=>value&&array.indexOf(value)===index).slice(0,8),scores:{interestStrength:null,evidenceConfidence:null,sourceCoverage:null,knowledgeCoverage:null,knowledgeReliability:null,expectedUsefulness:null,novelty:null,repetitionRisk:null,researchCost:0,resourcePressure:null,methodRef:'discovery-hypothesis-connection:1',limitations:[
  'Connection requires multiple distinct support evidence references and retains challenging evidence links.',
  'Unknown scores remain null; shared traits do not establish a personal motive or preference.',
  'Research cost is zero additional acquisition for this prepared candidate; it is not a system performance measurement.',
  'Live selection uses explicit topic matches before lexical overlap; no model-internal influence is claimed.'
 ]}};
}
/** Compile existing attributed material off the reply path. No new personal inference or acquisition. */
export function compileDiscoveryCandidates(parent:UnderstandingRecord,boundary:string,now=Date.now(),evidence:readonly FavoriteEvidence[]=[]):UnderstandingRecord[] {
 const brief=parent.recordType==='topicBrief';if(!brief&&parent.recordType!=='hypothesis')throw new Error('A current brief or tentative hypothesis is required');
 if(brief?parent.status!=='prepared':!['candidate','reviewed'].includes(String(parent.status)))return [];
 const topicRefs=brief?[String(parent.topicRef)]:parent.topicRefs as string[],parentRef=brief?`topic-brief:${parent.briefId}:${parent.revision}`:`hypothesis:${parent.hypothesisId}:${parent.revision}`;
 const support=brief?favoriteSupport(topicRefs,evidence,parent.dependencyRefs as string[]):[];
 const expires=Math.min(now+600000,brief?Date.parse(String(parent.freshUntil)):now+600000);
 if(!Number.isFinite(expires)||expires<=now)return [];
 const items:CandidateItem[]=brief?[...parent.claims as Record<string,unknown>[],...parent.aliasClaims as Record<string,unknown>[]].slice(0,6).map(item=>({text:String(item.text),sourceRefs:refs(item.sourceRefs),claimId:typeof item.claimId==='string'?item.claimId:null,kind:'discovery'})):[{text:`What, if anything, matters to you about ${topicRefs.join(', ')} in this context?`,sourceRefs:[],claimId:null,kind:'question'}];
 if(!brief){const connection=hypothesisConnection(parent,topicRefs,parentRef);if(connection)items.push(connection);}
 return items.map(item=>{
  const alternatives=item.alternatives??(brief?[]:(parent.explanations as Record<string,unknown>[]).map(explanation=>String(explanation.summary)));
  const limitations=item.limitations??(brief?['Attributed source assertion, not independently verified consensus.','Optional context: no duty to mention, recommendation, permission or personal preference is established.']:['The underlying explanations remain tentative; asking is optional.',String(parent.unknownAlternative),String(parent.uncertainty)]);
  const groundingRefs=[parentRef,...(item.claimId?[`claim:${item.claimId}`]:[]),...item.sourceRefs,...(item.groundingRefs??[]),...support.map(record=>record.ref)].filter((ref,index,array)=>array.indexOf(ref)===index).slice(0,32);
  const scoreLimitations=[...(support.length?['Interest strength 1 is an ordinal selection hint from an exact approved favorite statement, not a probability, inferred motive or general personal certainty. Other interests remain unknown.']:[]),'Unknown scores remain null; source presence never measures personal interest or enjoyment.','Research cost is zero additional acquisition for this prepared candidate; it is not a system performance measurement.','Live selection uses explicit topic matches before lexical overlap; no model-internal influence is claimed.'];
  const scores=item.scores??{interestStrength:support.length?1:null,evidenceConfidence:null,sourceCoverage:null,knowledgeCoverage:null,knowledgeReliability:null,expectedUsefulness:null,novelty:null,repetitionRisk:null,researchCost:0,resourcePressure:null,methodRef:support.length?favoriteMethod:'discovery-prepared-reference:1',limitations:scoreLimitations};
  const record:UnderstandingRecord={schemaVersion:'1.0.0',recordType:'candidate',assistantId:parent.assistantId,userId:parent.userId,relationshipId:parent.relationshipId,deploymentId:parent.deploymentId,candidateId:randomUUID(),revision:1,kind:item.kind,status:'proposed',content:String(item.text),topicRefs,groundingRefs,hypothesisRefs:brief?[]:[parentRef],alternatives,limitations,contextRef:`snapshot:${boundary}`,builtAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),configurationRef:parent.configurationRef,dependencyRefs:[parentRef,...parent.dependencyRefs as string[]].slice(0,32),scores,confersAuthority:false};
  if(!validator.validate('https://lifestream.dev/contracts/personal-understanding/1.0.0#/$defs/UnderstandingCandidate',record).valid)throw new Error('Invalid prepared candidate');
  return record;
 });
}
