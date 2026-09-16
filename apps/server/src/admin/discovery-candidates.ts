import {favoriteSupport,favoriteMethod,type FavoriteEvidence} from './discovery-preference.ts';
import {randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import type {UnderstandingRecord} from '@lifestream/storage-sqlite';

const validator=createContractValidator();
/** Compile existing attributed material off the reply path. No new personal inference or acquisition. */
export function compileDiscoveryCandidates(parent:UnderstandingRecord,boundary:string,now=Date.now(),evidence:readonly FavoriteEvidence[]=[]):UnderstandingRecord[] {
 const brief=parent.recordType==='topicBrief';if(!brief&&parent.recordType!=='hypothesis')throw new Error('A current brief or tentative hypothesis is required');
 if(brief?parent.status!=='prepared':!['candidate','reviewed'].includes(String(parent.status)))return [];
 const topicRefs=brief?[String(parent.topicRef)]:parent.topicRefs as string[],parentRef=brief?`topic-brief:${parent.briefId}:${parent.revision}`:`hypothesis:${parent.hypothesisId}:${parent.revision}`;
 const support=brief?favoriteSupport(topicRefs,evidence,parent.dependencyRefs as string[]):[];
 const expires=Math.min(now+600000,brief?Date.parse(String(parent.freshUntil)):now+600000);
 if(!Number.isFinite(expires)||expires<=now)return [];
 const items=brief?[...parent.claims as Record<string,unknown>[],...parent.aliasClaims as Record<string,unknown>[]].slice(0,6):[{text:`What, if anything, matters to you about ${topicRefs.join(', ')} in this context?`,sourceRefs:[],claimId:null}];
 return items.map(item=>{
  const alternatives=brief?[]:(parent.explanations as Record<string,unknown>[]).map(explanation=>String(explanation.summary));
  const record:UnderstandingRecord={schemaVersion:'1.0.0',recordType:'candidate',assistantId:parent.assistantId,userId:parent.userId,relationshipId:parent.relationshipId,deploymentId:parent.deploymentId,candidateId:randomUUID(),revision:1,kind:brief?'discovery':'question',status:'proposed',content:String(item.text),topicRefs,groundingRefs:[parentRef,...(item.claimId?[`claim:${item.claimId}`]:[]),...item.sourceRefs as string[],...support.map(record=>record.ref)].slice(0,32),hypothesisRefs:brief?[]:[parentRef],alternatives,limitations:brief?['Attributed source assertion, not independently verified consensus.','Optional context: no duty to mention, recommendation, permission or personal preference is established.']:['The underlying explanations remain tentative; asking is optional.',String(parent.unknownAlternative),String(parent.uncertainty)],contextRef:`snapshot:${boundary}`,builtAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),configurationRef:parent.configurationRef,dependencyRefs:[parentRef,...parent.dependencyRefs as string[]].slice(0,32),scores:{interestStrength:support.length?1:null,evidenceConfidence:null,sourceCoverage:null,knowledgeCoverage:null,knowledgeReliability:null,expectedUsefulness:null,novelty:null,repetitionRisk:null,researchCost:0,resourcePressure:null,methodRef:support.length?favoriteMethod:'discovery-prepared-reference:1',limitations:[...(support.length?['Interest strength 1 is an ordinal selection hint from an exact approved favorite statement, not a probability, inferred motive or general personal certainty. Other interests remain unknown.']:[]),'Unknown scores remain null; source presence never measures personal interest or enjoyment.','Research cost is zero additional acquisition for this prepared candidate; it is not a system performance measurement.','Live selection uses explicit topic matches before lexical overlap; no model-internal influence is claimed.']},confersAuthority:false};
  if(!validator.validate('https://lifestream.dev/contracts/personal-understanding/1.0.0#/$defs/UnderstandingCandidate',record).valid)throw new Error('Invalid prepared candidate');
  return record;
 });
}
