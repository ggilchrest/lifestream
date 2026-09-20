import {createHash} from 'node:crypto';
import {dimensions,type Item,type State,type Selection,type Topic} from './types.ts';
const topicDimension=Object.fromEntries(dimensions.map(x=>[x.slice(9).toLowerCase(),x]));
export const experienceDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words=(s:string)=>new Set((s.toLowerCase().match(/[a-z]{3,}/g)??[]));
export function selectExperience(state:State,input:string,audiencePrivate:boolean,at:number,id:string):{receipt:Selection;item:Item|null}{
 const receipt:Selection={recordType:'selection',id,revision:state.revision,considered:[],selected:null,reason:'disabled',inputDigest:experienceDigest(input),at:new Date(at).toISOString(),observedOutput:false};
 if(!state.configuration.enabled||state.configuration.frozen||!audiencePrivate)return {receipt,item:null};
 const invited=new Set<Topic>();for(const topic of Object.keys(state.configuration.topicPolicies) as Topic[])if(words(input).has(topic))invited.add(topic);
 // Current explicit work takes precedence. Selection is only an open invitation
 // or a related continuation; this never starts an unsolicited turn.
 const open=/\b(?:what (?:shall|should|could|can) we (?:do|work on|explore|try)(?: next| today| together)?[?.!]*$|suggest (?:an? )?(?:activity|project)[?.!]*$|(?:pick|choose) (?:something|a topic)[?.!]*$)/i.test(input);
 const continuation=/\b(continue|resume|next step|our project|work on next)\b/i.test(input);
 const denied=(topic:Topic)=>new RegExp('(?:do not|don.t|avoid|not|no)\\s+(?:mention |discuss |talk about |choose )?'+topic,'i').test(input);
 const eligible=state.items.filter(item=>item.disposition==='open'&&Date.parse(item.reconsiderAfter)<=at&&state.configuration.topicPolicies[item.topic]!=='disallowed'&&!denied(item.topic)&&(state.configuration.topicPolicies[item.topic]!=='invitationRequired'||invited.has(item.topic))&&(open||continuation&&invited.has(item.topic)));
 receipt.considered=eligible.map(i=>i.id);if(!eligible.length){receipt.reason=open?'noEligibleItems':'directRequest';return {receipt,item:null};}
 const score=(item:Item)=>state.imprints.find(i=>i.dimension===topicDimension[item.topic])?.value??0;
 eligible.sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));const selected=eligible[0]!;receipt.selected=selected.id;receipt.reason='ranked';return {receipt,item:selected};
}
