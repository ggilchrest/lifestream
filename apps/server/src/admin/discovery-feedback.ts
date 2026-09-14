import {randomUUID} from 'node:crypto';
import type {UnderstandingScope} from '@lifestream/storage-sqlite';
import type {RelationshipRecord,DiscoveryFeedback} from './relationship-records.ts';

const descriptions:Record<DiscoveryFeedback['kind'],string>={
 dislike:'dislike this topic',temporaryFatigue:'feel temporarily tired of this topic',poorTiming:'find the timing unsuitable',noProjectCapacity:'have no capacity for a project',alreadySatisfied:'already have this need satisfied',interestWithoutPurchaseIntent:'have interest without purchase intent',uncertain:'am uncertain about my preference'
};
export function feedbackIsCurrent(record:RelationshipRecord,now=Date.now()):boolean {
 return !record.discoveryFeedback?.until||Date.parse(record.discoveryFeedback.until)>now;
}
/** One new declaration in the existing evidence owner; no independent personal-truth store. */
export function createDiscoveryFeedback(records:readonly RelationshipRecord[],scope:UnderstandingScope,request:Record<string,unknown>,now=Date.now()):RelationshipRecord {
 const ref=String(request.evidenceRef),match=/^relationship-record:([a-f0-9-]{36}):(\d+)$/iu.exec(ref);
 const target=match&&records.find(record=>record.candidateId===match[1]&&record.revision===Number(match[2]));
 if(!target||target.status!=='approved'||target.processingRevoked||target.suppressed||target.audience==='ownerOnly'||target.approvedUse?.personalization===false||target.approvedUse?.mention===false||!feedbackIsCurrent(target,now))throw new Error('Select an available approved evidence record at its current revision.');
 if(records.length>=256)throw new Error('Relationship evidence capacity reached.');
 const kind=request.kind as DiscoveryFeedback['kind'],until=request.until as string|null;
 if(!(kind in descriptions)||until!==null&&(!Number.isFinite(Date.parse(until))||Date.parse(until)<=now))throw new Error('Feedback expiry must be a future time or explicitly unset.');
 const metadata:DiscoveryFeedback={version:1,topicRef:String(request.topicRef),evidenceRef:ref,kind,scope:String(request.scope),until};
 const temporal=until?`Only until ${until}.`:'No expiry was declared; this applies only within the stated scope.';
 const qualification=kind==='dislike'?'Do not generalize this to unrelated topics, traits or situations.':'This does not establish dislike of the topic or correlated traits.';
 return {candidateId:randomUUID(),content:`For ${metadata.topicRef}, within this scope: ${metadata.scope}, I ${descriptions[kind]}. ${temporal} ${qualification}`,source:'explicit-discovery-feedback',sourceFamily:`user-declaration:${scope.userId}`,uncertainty:'low',status:'pending',revision:1,contextUse:'correction',category:'declaration',assertedBy:scope.userId,createdAt:new Date(now).toISOString(),eventAt:new Date(now).toISOString(),evidenceBasis:'userDeclaration',sensitivity:target.sensitivity??'personal',derivedFrom:[target.candidateId],approvedUse:null,trainingExcluded:true,discoveryFeedback:metadata,history:[{operation:'discovery-feedback',actor:scope.userId,at:new Date(now).toISOString(),revision:1,relatedIds:[target.candidateId]}]};
}
