import {isDeepStrictEqual} from 'node:util';
import {TelegramPairingRepository,ChannelSubscriptionRepository,UrgentAwayRepository,type Database,type TelegramBinding} from '@lifestream/storage-sqlite';
import type {AuthorityDispatcher} from '@lifestream/runtime/capabilities/resolver';
import type {CapabilityScope} from '@lifestream/runtime/capabilities/ports';
import type {TelegramBotApi} from './telegram-api.ts';
import {TelegramNoticeProvider,telegramNoticeCapability} from './telegram-notice-provider.ts';
import {UrgentAwayRuntime,type UrgentAwaySource} from '../runtime/urgent-away.ts';
import type {UrgentAttentionRuntime,UrgentAttentionScope} from '../runtime/urgent-attention.ts';

export type TelegramAlertSession={sessionId:string;endpointId:string;revision:number};
export type TelegramAlertAuthority={scope:CapabilityScope;dispatch:AuthorityDispatcher;current:()=>boolean};
export type TelegramAlertComposition={source:UrgentAwaySource;authority:(binding:TelegramBinding,session:TelegramAlertSession)=>TelegramAlertAuthority|undefined;pollIntervalMs?:number};
type Options=TelegramAlertComposition&{database:Database;api:Pick<TelegramBotApi,'send'>;botId:string;ready:()=>boolean;session:(binding:TelegramBinding)=>TelegramAlertSession;assistantAvailable:(assistantId:string)=>boolean;runtime:UrgentAttentionRuntime};
type Route={binding:TelegramBinding;ownerId:string;session:TelegramAlertSession;scope:UrgentAttentionScope;fingerprint:string;worker:UrgentAwayRuntime};
/** Owner intent, subscriber consent, and authority are independent gates.
 * The host composes an existing authority route; no grants or login sessions
 * are created here. Only the fixed redacted notice contract is eligible. */
export class TelegramAlerts {
 private readonly options:Options;private readonly pairs:TelegramPairingRepository;private readonly records:UrgentAwayRepository;
 private readonly routes=new Map<string,Route>();private timer:ReturnType<typeof setInterval>|undefined;private closed=false;
 constructor(options:Options){this.options=options;this.pairs=new TelegramPairingRepository(options.database);this.records=new UrgentAwayRepository(options.database);}
 private owner(binding:TelegramBinding){return this.options.database.connection.prepare('SELECT a.principal_id AS id,a.epoch FROM channel_subscriptions s JOIN local_accounts a ON s.created_by=a.principal_id JOIN local_assistant_permissions p ON p.principal_id=a.principal_id AND p.assistant_id=s.assistant_id WHERE s.id=? AND a.owner=1 AND a.disabled=0 AND p.administer=1').get(binding.subscriptionId) as {id:string;epoch:number}|undefined;}
 private recipientEpoch(binding:TelegramBinding){return Number(this.options.database.connection.prepare('SELECT epoch FROM local_accounts WHERE principal_id=? AND disabled=0').get(binding.principalId)?.epoch??-1);}
 available(){try{return !this.closed&&this.options.ready();}catch{return false;}}
 canEnable(id:string){return this.available()&&(this.routes.has(id)||this.pairs.activeBindings(this.options.botId).filter(b=>b.alertsEnabled).length<8);}
 reconcile(){
  if(this.closed)return;
  const keep=new Set<string>();
  if(this.available())for(const binding of this.pairs.activeBindings(this.options.botId).filter(b=>b.alertsEnabled).slice(0,8)){
   try{
    const owner=this.owner(binding);if(!owner||!this.options.assistantAvailable(binding.assistantId))continue;
    const session=this.options.session(binding),authority=this.options.authority(binding,session);if(!authority||!authority.current()||authority.scope.assistantId!==binding.assistantId||authority.scope.endpointId!==session.endpointId||authority.scope.sessionId!==session.sessionId)continue;
    const epoch=this.recipientEpoch(binding),fingerprint=JSON.stringify([binding,owner,session,authority.scope,epoch]),previous=this.routes.get(binding.subscriptionId);keep.add(binding.subscriptionId);
    if(previous?.fingerprint===fingerprint){previous.worker.reconcile();continue;}
    previous?.worker.close();this.routes.delete(binding.subscriptionId);
    const scope={assistantId:binding.assistantId,principalId:binding.principalId,endpointId:session.endpointId};
    const current=()=>{try{const a=this.options.authority(binding,session);return this.available()&&this.pairs.current(binding)&&this.options.assistantAvailable(binding.assistantId)&&JSON.stringify(this.owner(binding))===JSON.stringify(owner)&&this.recipientEpoch(binding)===epoch&&isDeepStrictEqual(this.options.session(binding),session)&&!!a?.current()&&isDeepStrictEqual(a.scope,authority.scope);}catch{return false;}};
    const provider=new TelegramNoticeProvider({database:this.options.database,api:this.options.api,scope:authority.scope,binding,allowed:current});
    const worker=new UrgentAwayRuntime(this.options.database,{runtime:this.options.runtime,source:this.options.source,pollIntervalMs:this.options.pollIntervalMs??1000,destinations:[{destinationRef:binding.subscriptionId,revision:binding.revision,scope,identity:{assistantRef:binding.assistantId,endpointRef:session.endpointId,participantRefs:[binding.principalId],audienceRef:'redacted-private-chat'},capabilityScope:authority.scope,capabilityId:telegramNoticeCapability.id,capabilityVersion:telegramNoticeCapability.version,capabilityRoute:telegramNoticeCapability.route,provider,dispatch:authority.dispatch,current,facts:()=>({scope,sessionId:session.sessionId,sessionRevision:session.revision,audienceRevision:binding.revision,authorizationRevision:epoch,authorized:current(),privateAudience:true,attentionSuitable:true,outputReady:this.available()}),evidenceReferencesAllowed:()=>false}]});
    this.routes.set(binding.subscriptionId,{binding,ownerId:owner.id,session,scope,fingerprint,worker});worker.start();
   }catch{/* Unavailable composition never enables or guesses an authority scope. */}
  }
  for(const [id,route] of this.routes)if(!keep.has(id)){route.worker.close();this.routes.delete(id);}
 }
 inspectOwner(assistantId:string,ownerId:string){this.reconcile();return [...this.routes.values()].filter(r=>r.binding.assistantId===assistantId&&r.ownerId===ownerId).map(r=>({destinationRef:r.binding.subscriptionId,destinationLabel:new ChannelSubscriptionRepository(this.options.database).list(assistantId).find(s=>s.id===r.binding.subscriptionId)?.label??r.binding.subscriptionId,destinationRevision:r.binding.revision,...this.options.runtime.inspect(r.scope),worker:r.worker.inspect(r.scope),acknowledgmentAllowed:r.binding.principalId===ownerId}));}
 ownerRoute(assistantId:string,ownerId:string,id:string){this.reconcile();const r=this.routes.get(id);return r?.binding.assistantId===assistantId&&r.ownerId===ownerId?r:undefined;}
 recipient(principalId:string,id:string){
  const sub=new ChannelSubscriptionRepository(this.options.database).listForPrincipal(principalId).find(s=>s.id===id);if(!sub)throw Error('Subscriber destination unavailable');
  const route=this.routes.get(id),endpoint=this.options.database.connection.prepare('SELECT s.endpoint_id FROM telegram_conversation_sessions c JOIN sessions s ON c.session_id=s.id WHERE c.subscription_id=?').get(id) as {endpoint_id:string}|undefined;
  const deliveries=endpoint?this.records.inspect({assistantId:sub.assistantId,principalId,endpointId:endpoint.endpoint_id}).filter(r=>r.destinationRef===id).map(r=>({id:r.id,revision:r.revision,state:r.state,attemptedAt:r.attemptedAt,acceptedAt:r.acceptedAt,acknowledgedAt:r.acknowledgedAt})):[];
  return {configured:!!route,requiresOwnerPolicy:!!route&&!this.options.runtime.settings(route.scope).rules.some(r=>r.enabled),deliveries};
 }
 acknowledge(principalId:string,subscriptionId:string,id:string,revision:number){
  const sub=new ChannelSubscriptionRepository(this.options.database).listForPrincipal(principalId).find(s=>s.id===subscriptionId),record=this.records.get(id);if(!sub||!record||record.destinationRef!==subscriptionId||record.scope.principalId!==principalId||record.scope.assistantId!==sub.assistantId)throw Error('Subscriber alert unavailable');
  this.records.acknowledge(record.scope,id,revision,new Date().toISOString());
 }
 start(){if(this.closed||this.timer)return;this.timer=setInterval(()=>this.reconcile(),250);this.timer.unref();this.reconcile();}
 close(){if(this.closed)return;this.closed=true;if(this.timer)clearInterval(this.timer);for(const r of this.routes.values())r.worker.close();this.routes.clear();}
}
