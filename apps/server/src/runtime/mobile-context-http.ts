import {admitRemovalControlConsumer,removalControlEnvelope,removalControlResponse,removalControlPin} from '@lifestream/contracts/mobile-context-removal-settlement';
import {admitCalendarSelectedConsumer,calendarSelectedEnvelope,calendarSelectedResponse,calendarSelectedDeliveryPin} from '@lifestream/contracts/mobile-context-calendar-selected-delivery';
import {admitCalendarSettingsConsumer,calendarSettingsEnvelope,calendarSettingsResponse,calendarSettingsControlPin} from '@lifestream/contracts/mobile-context-calendar-settings-control';
import{admitCalendarChoicesConsumer,calendarChoicesSnapshot,calendarChoicesLimits,mobileCalendarChoicesPin,type CalendarChoicesQuery,type CalendarChoicesResponse}from'@lifestream/contracts/mobile-context-calendar-choices';
import{admitCalendarContextConsumer,calendarContextSnapshot,calendarContextLimits,freezeCalendarContext,mobileCalendarContextPin,type CalendarContextQuery}from'@lifestream/contracts/mobile-context-calendar-context';
import {admitOrdinaryControlConsumer,ordinaryControlEnvelope,ordinaryControlResponse,ordinaryControlPin} from '@lifestream/contracts/mobile-context-control-settlement';
import{admitCalendarDeliveryConsumer,calendarDeliverySnapshot,mobileCalendarDeliveryPin,type CalendarDeliveryRequest,type CalendarDeliveryResponse}from'@lifestream/contracts/mobile-context-calendar-delivery';
import {admitMobileInterpretationConsumer,mobileInterpretationRequest} from '@lifestream/contracts/mobile-context-interpretation';
import{admitMobileInventoryConsumer,mobileInventoryPin,mobileInventorySnapshot}from'@lifestream/contracts/mobile-context-inventory';
import type{MobileAccess,MobileConfiguration,MobileEnrollment}from'@lifestream/storage-sqlite';
import type{ContextQuery}from'@lifestream/contracts/mobile-context';
import{admitMobileContextConsumer,mobileContextPin}from'@lifestream/contracts/mobile-context';
import{unifiedDesktopSnapshot}from'@lifestream/contracts/unified-desktop-contracts';
import{MobileContextService}from'./mobile-context.ts';
import{MobileControlError}from'@lifestream/storage-sqlite';
import{admitMobileControlConsumer,mobileControlRequest}from'@lifestream/contracts/mobile-context-control';
/** Mounted only by the existing authenticated host. No cookie or human identity parser here. */
export function mobileContextOperation(service:MobileContextService,input:unknown,resolve:(assistantId?:string)=>MobileAccess){
 const body=unifiedDesktopSnapshot(input,262144)as Record<string,unknown>|undefined;
 if(body&&admitCalendarSelectedConsumer(body.producerPin)){
  const request=calendarSelectedEnvelope(body);if(!request)return {status:422,body:{code:'calendar_selected_invalid'}};
  try{const access=resolve(),receipts=service.repository.ingestCalendarSelected(access,request.payload);const response=calendarSelectedResponse({schemaVersion:'1.0.0',producerPin:calendarSelectedDeliveryPin,result:{kind:'sync',receipts}});return response?{status:200,body:response}:{status:503,body:{code:'calendar_selected_unavailable'}};}catch{return {status:403,body:{code:'calendar_selected_unavailable'}};}
 }
 if(body&&admitCalendarSettingsConsumer(body.producerPin)){
  const request=calendarSettingsEnvelope(body);if(!request)return {status:422,body:{code:'calendar_settings_invalid'}};
  try{const access=resolve();let result;
   if(request.operation==='control')result=service.repository.calendarControl(access,request.payload);
   else if(request.operation==='reconcile')result=service.repository.reconcileCalendarControl(access,request.payload);
   else if(request.operation==='inspect')result=service.repository.calendarSettings(access,request.payload.enrollmentId);
   else if(request.operation==='ingestScoped')result={kind:'sync' as const,receipts:service.repository.ingestCalendarScoped(access,request.payload)};
   else throw Error('calendar_settings_operation');
   const response=calendarSettingsResponse({schemaVersion:'1.0.0',producerPin:calendarSettingsControlPin,result});
   if(!response||!access.current())return {status:403,body:{code:'calendar_settings_unavailable'}};
   return {status:200,body:response};
  }catch{return {status:403,body:{code:'calendar_settings_unavailable'}};}
 }
 if(body?.operation==='calendarChoices'){
  if(Object.keys(body).sort().join(',')!=='operation,payload,producerPin'||!admitCalendarChoicesConsumer(body.producerPin)||Buffer.byteLength(JSON.stringify(body))>calendarChoicesLimits.requestBytes)return {status:422,body:{code:'calendar_choices_invalid'}};
  const query=calendarChoicesSnapshot<CalendarChoicesQuery>('CalendarChoicesQuery',body.payload);if(!query)return {status:422,body:{code:'calendar_choices_invalid'}};
  try{const prepared=service.calendarChoices(resolve(query.assistantId),query),result=calendarChoicesSnapshot<CalendarChoicesResponse>('CalendarChoicesResponse',{schemaVersion:'1.0.0',producerPin:mobileCalendarChoicesPin,result:prepared.result});if(!result)return {status:503,body:{code:'calendar_choices_unavailable'}};freezeCalendarContext(result);if(Buffer.byteLength(JSON.stringify(result))>calendarChoicesLimits.responseBytes||!prepared.current())return {status:403,body:{code:'calendar_choices_unavailable'}};return {status:200,body:result};}
  catch{return {status:403,body:{code:'calendar_choices_unavailable'}};}
 }
 if(body?.operation==='calendarContext'){
  if(Object.keys(body).sort().join(',')!=='operation,payload,producerPin'||!admitCalendarContextConsumer(body.producerPin)||Buffer.byteLength(JSON.stringify(body))>calendarContextLimits.requestBytes)return {status:422,body:{code:'calendar_context_invalid'}};
  const query=calendarContextSnapshot<CalendarContextQuery>('CalendarContextQuery',body.payload);if(!query)return {status:422,body:{code:'calendar_context_invalid'}};
  try{const prepared=service.calendarContext(resolve(query.assistantId),query),result=calendarContextSnapshot('CalendarContextResponse',{schemaVersion:'1.0.0',producerPin:mobileCalendarContextPin,result:prepared.page});if(!result)return {status:503,body:{code:'calendar_context_unavailable'}};freezeCalendarContext(result);if(Buffer.byteLength(JSON.stringify(result))>calendarContextLimits.responseBytes||!prepared.current())return {status:403,body:{code:'calendar_context_unavailable'}};return {status:200,body:result};}
  catch(error){return error instanceof Error&&error.message==='calendar_context_restart_required'?{status:409,body:{code:'calendar_context_restart_required'}}:{status:403,body:{code:'calendar_context_unavailable'}};}
 }

 if(body&&admitRemovalControlConsumer(body.producerPin)){
  const envelope=removalControlEnvelope(body);if(!envelope)return {status:422,body:{code:'removal_control_invalid'}};
  if(!service.repository.controlsEnabled)return {status:503,body:{code:'removal_control_unavailable'}};
  try{const access=resolve(),result=envelope.operation==='control'?service.repository.controlRemoval(access,envelope.payload):service.repository.reconcileRemovalControl(access,envelope.payload),response=removalControlResponse({schemaVersion:'1.0.0',producerPin:removalControlPin,result});
   return response?{status:200,body:response}:{status:403,body:{code:'removal_control_unavailable'}};
  }catch(error){return error instanceof MobileControlError?{status:error.status,body:{code:'removal_control_'+error.code}}:{status:403,body:{code:'removal_control_unavailable'}};}
 }
 if(body&&admitOrdinaryControlConsumer(body.producerPin)){
  const envelope=ordinaryControlEnvelope(body);if(!envelope)return {status:422,body:{code:'ordinary_control_invalid'}};
  if(!service.repository.controlsEnabled)return {status:503,body:{code:'ordinary_control_unavailable'}};
  try{const original=resolve(),ids=envelope.operation==='control'&&envelope.payload.action.kind==='configure'?envelope.payload.action.configuration.assistantIds:[];
   for(const id of ids)resolve(id);
   const access=ids.length?{...original,current:()=>{try{return original.current()&&ids.every(id=>resolve(id).current());}catch{return false;}}}:original;
   const result=envelope.operation==='control'?service.repository.controlGeneral(access,envelope.payload):service.repository.reconcileGeneralControl(access,envelope.payload),response=ordinaryControlResponse({schemaVersion:'1.0.0',producerPin:ordinaryControlPin,result});
   // The repository owns final publication checks; serialization is pure.
   if(!response)return {status:403,body:{code:'ordinary_control_unavailable'}};return {status:200,body:response};
  }catch(error){return error instanceof MobileControlError?{status:error.status,body:{code:'ordinary_control_'+error.code}}:{status:403,body:{code:'ordinary_control_unavailable'}};}
 }
 const calendar=body?.operation==='calendar',interpretation=body?.operation==='interpretation',control=body?.operation==='control'||body?.operation==='reconcileControl';
 if(!body||Object.keys(body).some(k=>!['producerPin','operation','payload'].includes(k))||!(interpretation?admitMobileInterpretationConsumer(body.producerPin):calendar?admitCalendarDeliveryConsumer(body.producerPin):control?admitMobileControlConsumer(body.producerPin)&&service.repository.controlsEnabled:body.operation==='inventory'?admitMobileInventoryConsumer(body.producerPin):admitMobileContextConsumer(body.producerPin))||typeof body.operation!=='string'||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))return {status:422,body:{code:'mobile_request_invalid'}};
 const payload=body.payload as Record<string,unknown>,assistant=typeof payload.assistantId==='string'?payload.assistantId:undefined;
 try{const access=resolve(assistant),repo=service.repository;let result:unknown;
 if(calendar){
  const respond=(result:CalendarDeliveryResponse['result'])=>{const body=calendarDeliverySnapshot<CalendarDeliveryResponse>('CalendarDeliveryResponse',{schemaVersion:'1.0.0',producerPin:mobileCalendarDeliveryPin,result});if(!body||!access.current())throw Error('calendar_response_unavailable');return{status:200,body};};
  // The server keeps valid siblings independent of a structurally invalid item.
  // Native prepared requests remain strictly validated against the producer.
  if(payload.operation==='ingest'){if(Object.keys(payload).sort().join(',')!=='items,operation,schemaVersion'||payload.schemaVersion!=='1.0.0')return{status:422,body:{code:'calendar_request_invalid'}};return respond({kind:'sync',receipts:repo.ingestCalendar(access,{schemaVersion:'1.0.0',items:payload.items})});}
  const request=calendarDeliverySnapshot<CalendarDeliveryRequest>('CalendarDeliveryRequest',payload);if(!request)return{status:422,body:{code:'calendar_request_invalid'}};
  if(request.operation==='enroll')return respond({kind:'enrollment',enrollment:repo.createCalendarUnbound(access,request.collector)});
  if(request.operation==='bindSource')return respond({kind:'enrollment',enrollment:repo.bindCalendarSource(access,request.enrollmentId,request.expectedRevision,request.binding)});
  if(request.operation==='policy')return respond(repo.calendarEffective(access,request.enrollmentId));
  if(request.operation==='configure'){const authorities=request.configuration.assistantIds.map(id=>resolve(id)),bound={...access,current:()=>{try{return access.current()&&authorities.every(a=>a.current());}catch{return false;}}};const enrollment=repo.configureCalendar(bound,request.enrollmentId,request.expectedRevision,request.state,request.configuration);if(!bound.current())throw Error('calendar_scope_unavailable');return respond({kind:'enrollment',enrollment});}
  return{status:422,body:{code:'calendar_operation_invalid'}};
 }
 if(interpretation){const request=mobileInterpretationRequest(payload);if(!request)return {status:422,body:{code:'mobile_interpretation_invalid'}};const scoped=request.operation==='reconcile'?access:resolve(request.query.assistantId);if(request.operation==='apply'||request.operation==='reverse'){if(request.controlOriginal.action.kind!=='configure')throw Error('invalid');const authorities=request.controlOriginal.action.configuration.assistantIds.map(id=>resolve(id)),bound={...scoped,current:()=>{try{return scoped.current()&&authorities.every(a=>a.current());}catch{return false;}}};const result=service.interpretation.handle(bound,request);if(!bound.current())return {status:403,body:{code:'mobile_scope_unavailable'}};return result;}const result=service.interpretation.handle(scoped,request);if(!scoped.current())return {status:403,body:{code:'mobile_scope_unavailable'}};return result;}
 if(control){const request=mobileControlRequest(payload);if(!request)return {status:422,body:{code:'mobile_control_invalid'}};
  if(body.operation==='reconcileControl')return {status:200,body:repo.reconcileControl(access,request)};
  const ids=request.action.kind==='configure'?request.action.configuration.assistantIds:[];for(const id of ids)resolve(id);
  const bound={...access,current:()=>{try{return access.current()&&ids.every(id=>resolve(id).current());}catch{return false;}}};return {status:200,body:repo.control(bound,request)};
 }
 switch(body.operation){
  case'inventory':{const result=repo.ownerInventory(access,payload);const response={schemaVersion:'1.0.0',producerPin:mobileInventoryPin,result};if(!mobileInventorySnapshot('MobileInventoryResponse',response)||!access.current())throw Error('invalid');return {status:200,body:response};}
  case'enroll':if(Object.keys(payload).join()!=='collector')throw Error('invalid');result=repo.createUnbound(access,payload.collector as MobileEnrollment['collector']);break;
  case'bindSource':if(Object.keys(payload).some(k=>!['enrollmentId','expectedRevision','binding'].includes(k)))throw Error('invalid');result=repo.bindSource(access,String(payload.enrollmentId),Number(payload.expectedRevision),payload.binding as {sourceNamespace:string}|{createNew:true});break;
  case'policy':if(Object.keys(payload).join()!=='enrollmentId')throw Error('invalid');result=repo.effective(access,String(payload.enrollmentId));break;
  case'configure':if(Object.keys(payload).some(k=>!['enrollmentId','expectedRevision','state','configuration'].includes(k)))throw Error('invalid');if(Array.isArray((payload.configuration as MobileConfiguration)?.assistantIds))for(const id of (payload.configuration as MobileConfiguration).assistantIds)resolve(id);result=repo.configure(access,String(payload.enrollmentId),Number(payload.expectedRevision),payload.state as MobileEnrollment['state'],payload.configuration as MobileConfiguration);break;
  case'ingest':result=repo.ingest(access,payload);break;
  case'query':result=repo.query(access,payload);break;
  case'answerSleep':result=service.answerSleep(access,payload as ContextQuery);break;
  case'remove':if(Object.keys(payload).some(k=>!['enrollmentId','expectedRevision'].includes(k)))throw Error('invalid');result=repo.removeImported(access,String(payload.enrollmentId),Number(payload.expectedRevision));break;
  default:return {status:422,body:{code:'mobile_operation_invalid'}};
 }
 if(!access.current())return {status:403,body:{code:'mobile_scope_unavailable'}};return {status:200,body:{schemaVersion:'1.0.0',producerPin:mobileContextPin,result}};
 }catch(error){if(error instanceof MobileControlError)return {status:error.status,body:{code:'mobile_control_'+error.code}};return {status:403,body:{code:'mobile_scope_or_settings_unavailable'}};}
}
