import {createHash} from "node:crypto";
import {createContractValidator} from "@lifestream/contracts";
import type {InitiativeScope,InitiativeOpportunity} from "@lifestream/storage-sqlite";
import type {InitiativePrompt} from "@lifestream/runtime/inference/prompt";

type Dimensions=Omit<InitiativePrompt,"opportunityId"|"kind">;
const keys=["initiative","warmth","curiosity","followThrough","persistence"] as const;
const defaults:Dimensions={initiative:0,warmth:5,curiosity:3,followThrough:3,persistence:0};
const validator=createContractValidator();
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function initiativePreset(level:number):Dimensions {
 if(!Number.isInteger(level)||level<0||level>11)throw new Error("Initiative must be an integer from 0 to 11.");
 return level<=3?{...defaults,initiative:level}:level<=6?{initiative:level,warmth:7,curiosity:5,followThrough:5,persistence:2}:level<=9?{initiative:level,warmth:8,curiosity:7,followThrough:7,persistence:3}:{initiative:level,warmth:10,curiosity:9,followThrough:9,persistence:4};
}
export function initiativeSettingsError(settings:Record<string,unknown>):string|undefined {
 if(settings.preset==="custom")return undefined;
 const level=Number(settings.proactiveness),expected=initiativePreset(level),band=level===0?"reactive":level<=3?"reserved":level<=6?"friendly":level<=9?"engaged":"highlyEngaged";
 if(settings.preset!==band||keys.some(key=>object(settings.dimensions)[key]!==expected[key]))return "The named preset and advanced dimensions disagree. Select Custom to review independent values.";
 return undefined;
}
export type InitiativeFacts={
 sessionId:string;endpointId:string;modality:"text"|"speech"|"presentation";kind:InitiativeOpportunity["kind"];
 context:"privateAvailable"|"shared"|"focused"|"quiet"|"unavailable"|"unknown";
 authorized:boolean;identityQualified:boolean;privateAudience:boolean;consentCurrent:boolean;
 sourceQualified:boolean;sourceExpiresAt:number;outputReady:boolean;leaseAvailable:boolean;
 dwellSeconds?:number;absenceSeconds?:number;unfinishedEvidenceCurrent?:boolean;
};
export type InitiativeTemporaryMode={kind:"quiet"|"companionship";sessionId:string;configurationId:string;createdAt:number;expiresAt:number|null;dimensions?:Dimensions};
export type InitiativePolicy={dimensions:Dimensions;expressionWarmth:number;revision:string;allowed:boolean;reasons:string[];sources:{dimension:string;sourceRef:string;value:number}[];limitations:string[]};
const reasonOrder=["invalidScope","notOptedIn","consentRevoked","configurationChanged","identityUnqualified","staleSource","expired","duplicate","unansweredTopic","insufficientAbsence","insufficientDwell","quiet","focused","unavailable","audienceChanged","privacyInsufficient","contextRestricted","defaultReactive","reserved","openingBudget","cooldown","queueLimit","inferenceBudget","noCandidate","leaseLost","endpointUnavailable"];

/** Cheap host policy. No prose interpretation, learning, new grants, capture or I/O.
 * Configuration sources do not establish any of the supplied current runtime facts. */
export function resolveInitiativePolicy(input:{scope:InitiativeScope;configuration?:Record<string,unknown>;profile?:Record<string,unknown>|undefined;facts?:InitiativeFacts;temporary?:InitiativeTemporaryMode;now:number;preview?:boolean;previewConsentCurrent?:boolean}):InitiativePolicy {
 const {configuration:config,profile,facts,now}=input,reasons:string[]=[],limitations:string[]=[],sources:InitiativePolicy["sources"]=[],dimensions={...defaults};
 const deny=(reason:string)=>{if(!reasons.includes(reason))reasons.push(reason);};
 const bounds=Object.fromEntries(keys.map(key=>[key,{minimum:0,maximum:11}])) as Record<keyof Dimensions,{minimum:number;maximum:number}>;
 const declared=new Set<string>();
 const profileRef=profile?`assistant-profile:${profile.profileId}:${profile.revision}`:"assistant-disposition:undeclared";
 const declarations=object(profile?.adaptivePersonaPolicy).dimensions;
 if(Array.isArray(declarations))for(const key of keys){
  const matches=declarations.filter(v=>object(v).key===key).map(object);
  if(matches.length>1){deny("invalidScope");limitations.push(`Duplicate declared ${key} bounds require review.`);continue;}
  const d=matches[0];if(!d)continue;
  const baseline=d.baseline,min=d.minimum,max=d.maximum;
  if(d.valueType!=="number"||typeof baseline!=="number"||typeof min!=="number"||typeof max!=="number"||![baseline,min,max].every(Number.isFinite)||min>baseline||baseline>max){deny("invalidScope");continue;}
  // Existing reply warmth is 0..1. It maps into the same effective expression
  // dimension; no second persistent warmth record is created.
  const scale=key==="warmth"&&min>=0&&max<=1?11:1;
  const minimum=Math.ceil(min*scale),maximum=Math.floor(max*scale),value=Math.round(baseline*scale);
  if(minimum<0||maximum>11||minimum>maximum||value<minimum||value>maximum||(scale===1&&!Number.isInteger(baseline))){deny("invalidScope");limitations.push(`Declared ${key} cannot be represented by the 0–11 control.`);continue;}
  bounds[key]={minimum,maximum};dimensions[key]=value;declared.add(key);
  if(scale===11)limitations.push(`Declared Assistant warmth ${baseline} on the 0–1 scale maps to integer ${value} on 0–11; the reviewed relationship override remains separate from this default.`);
 }
 for(const key of keys)sources.push({dimension:key,sourceRef:declared.has(key)?profileRef:`assistant-disposition:undeclared:${key}`,value:dimensions[key]});
 if(!profile||profile.status!=="active")deny("configurationChanged");
 if(profile&&profile.assistantId!==input.scope.assistantId)deny("invalidScope");
 const valid=config&&validator.validate("https://lifestream.dev/contracts/relational-initiative/1.0.0#/$defs/RelationalInitiativeConfiguration",config).valid;
 if(config&&!valid)deny("invalidScope");
 if(valid){
  if(["assistantId","userId","relationshipId","deploymentId"].some(key=>config[key]!==input.scope[key as keyof InitiativeScope]))deny("invalidScope");
  if(config.lifecycle!=="active"&&!input.preview)deny("configurationChanged");
  if(config.parentConfigurationRevision!==`${config.configurationId}:${config.revision}`||initiativeSettingsError(config))deny("invalidScope");
  for(const key of keys){const value=object(config.dimensions)[key] as number;if(value<bounds[key].minimum||value>bounds[key].maximum){deny("contextRestricted");limitations.push(`Selected ${key} ${value} is outside the declared bounds ${bounds[key].minimum}–${bounds[key].maximum} on the 0–11 control.`);}dimensions[key]=value;sources.push({dimension:key,sourceRef:`relationship-configuration:${config.configurationId}:${config.revision}`,value});}
 }else deny("defaultReactive");
 let mode:InitiativeTemporaryMode|undefined;
 if(input.temporary){const t=input.temporary;
  if(!facts||!valid||t.sessionId!==facts.sessionId||t.configurationId!==config.configurationId||!Number.isFinite(t.createdAt)||t.createdAt>now||!['quiet','companionship'].includes(t.kind)||t.expiresAt!==null&&(!Number.isFinite(t.expiresAt)||t.expiresAt<=t.createdAt))deny("invalidScope");
  else if(t.expiresAt===null||t.expiresAt>now){
   if(t.kind==="companionship"&&(t.expiresAt===null||t.expiresAt-t.createdAt<300_000||t.expiresAt-t.createdAt>28_800_000||!t.dimensions))deny("invalidScope");
   else mode=t;
  }
 }
 if(mode?.kind==="quiet")deny("quiet");
 if(mode?.kind==="companionship")for(const key of keys){const value=mode.dimensions![key];if(!Number.isInteger(value)||value<bounds[key].minimum||value>bounds[key].maximum)deny("contextRestricted");else{dimensions[key]=value;sources.push({dimension:key,sourceRef:`temporary-companionship:${mode.sessionId}:${mode.expiresAt}`,value});}}
 if(!Number.isFinite(now))deny("invalidScope");
 if(dimensions.initiative===0)deny("defaultReactive");else if(dimensions.initiative<4)deny("reserved");
 if(!valid||!(config.consentRefs as string[]).length)deny("notOptedIn");
 else if((facts?facts.consentCurrent:input.previewConsentCurrent)!==true)deny("consentRevoked");
 if(!facts){deny("unavailable");limitations.push("Current opportunity, availability and playback readiness have not been established by this configuration review.");}
 else{
  if(facts.authorized!==true||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(facts.sessionId))deny("invalidScope");
  if(facts.identityQualified!==true)deny("identityUnqualified");
  if(facts.sourceQualified!==true||!Number.isFinite(facts.sourceExpiresAt))deny("staleSource");else if(facts.sourceExpiresAt<=now)deny("expired");
  if(facts.context==="quiet")deny("quiet");else if(facts.context==="focused")deny("focused");else if(["unavailable","unknown"].includes(facts.context))deny("unavailable");
  if(facts.privateAudience!==true||facts.context==="shared")deny("privacyInsufficient");
  if(valid){
   if(!(config.allowedContexts as string[]).includes(facts.context)||!(config.endpointIds as string[]).includes(facts.endpointId)||!(config.allowedModalities as string[]).includes(facts.modality)||!(config.allowedKinds as string[]).includes(facts.kind))deny("contextRestricted");
   const tuning=object(config.tuning);
   if(facts.kind==="arrivalReturn"){
    if(!Number.isFinite(facts.absenceSeconds)||facts.absenceSeconds!<Number(tuning.meaningfulAbsenceSeconds))deny("insufficientAbsence");
    if(!Number.isFinite(facts.dwellSeconds)||facts.dwellSeconds!<Number(tuning.arrivalDwellSeconds))deny("insufficientDwell");
   }
   if(facts.kind==="availableCheckIn"&&tuning.checkInIntervalSeconds===0)deny("contextRestricted");
   if(facts.kind==="groundedFollowUp"&&facts.unfinishedEvidenceCurrent!==true)deny("noCandidate");
   if(Number(tuning.openingsPerHour)===0||Number(tuning.openingsPerDay)===0)deny("openingBudget");
   if(Number(tuning.inferenceCallsPerRelationshipHour)===0||Number(tuning.inferenceCallsPerRuntimeHour)===0)deny("inferenceBudget");
  }
  if(facts.leaseAvailable!==true)deny("leaseLost");if(facts.outputReady!==true)deny("endpointUnavailable");
 }
 reasons.sort((a,b)=>reasonOrder.indexOf(a)-reasonOrder.indexOf(b));
 limitations.push("Current restrictions and durable budgets still require a final delivery check. Core Persona prose remains protected in the shared prompt; this numeric resolver does not reinterpret it.","No silence, model suggestion or timing adaptation changes these explicit dimensions or grants a channel.");
 const revision=createHash("sha256").update(JSON.stringify({scope:input.scope,profileRef,bounds,config:config??null,mode:mode??null,dimensions})).digest("hex");
 return {dimensions,expressionWarmth:dimensions.warmth/11,revision,allowed:input.preview!==true&&reasons.length===0,reasons,sources,limitations};
}

export function initiativePolicyExplanations(policy:InitiativePolicy):{code:string;summary:string;sourceRefs:string[]}[]{
 return [{code:"initiative_dimensions",summary:`Effective controls (0–11): initiative ${policy.dimensions.initiative}; warmth ${policy.dimensions.warmth}; curiosity ${policy.dimensions.curiosity}; follow-through ${policy.dimensions.followThrough}; persistence ${policy.dimensions.persistence}. Opening warmth maps to ${policy.expressionWarmth.toFixed(3)} on the existing 0–1 expression scale.`,sourceRefs:[...new Set(policy.sources.map(s=>s.sourceRef))]},
 {code:"initiative_delivery_review",summary:`Configuration review does not admit an opening. Current delivery restrictions: ${policy.reasons.map(reason=>({invalidScope:"scope or values need review",notOptedIn:"no explicit output opt-in",consentRevoked:"consent is unavailable or revoked",configurationChanged:"no current active Assistant or configuration",unavailable:"no current available opportunity",defaultReactive:"reactive settings",reserved:"reserved settings do not generate social openings",contextRestricted:"selected context, channel, kind or protected bounds do not permit this opening",privacyInsufficient:"private audience is not established",quiet:"quiet mode",focused:"focus mode",identityUnqualified:"subject identity is not qualified",staleSource:"source qualification is unavailable",expired:"source expired",insufficientAbsence:"absence is too short",insufficientDwell:"arrival dwell is too short",noCandidate:"no current unfinished-topic evidence",openingBudget:"opening budget is zero",inferenceBudget:"inference budget is zero",leaseLost:"output ownership is unavailable",endpointUnavailable:"endpoint output is not ready"} as Record<string,string>)[reason]??reason).join("; ")||"none in supplied host facts; final checks still apply"}.`,sourceRefs:[`initiative-policy:${policy.revision}`]},
 ...policy.limitations.map(summary=>({code:"initiative_policy_limit",summary,sourceRefs:[]}))];
}
