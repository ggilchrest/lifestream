import type {MobileControlRequest,MobileControlResponse,MobileControlOutcome} from './mobile-context-control.types.ts';
import type {removalControlPin} from './mobile-context-removal-settlement.pin.ts';
export type RemovalControlRequest=MobileControlRequest & {action:Extract<MobileControlRequest['action'],{kind:'remove'}>};
export type RemovalControlEnvelope={producerPin:typeof removalControlPin;operation:'control'|'reconcile';payload:RemovalControlRequest};
export type RemovalControlBinding={family:'sourceRemovalControl';reservationDigest:string;preparedDigest:string;terminalDigest:string};
type RemovalNestedControl=MobileControlResponse & {result:MobileControlOutcome & {originalRequest:RemovalControlRequest}};
type AppliedRemoval=RemovalNestedControl & {result:Extract<MobileControlOutcome,{status:'applied'}>};
export type RemovalControlResult={kind:'held';reason:'pending'|'unknown'|'unqualified'|'otherFamily'|'unavailable'}|{kind:'observed';control:RemovalNestedControl}|{kind:'terminal';binding:RemovalControlBinding;control:AppliedRemoval};
export type RemovalControlResponse={schemaVersion:'1.0.0';producerPin:typeof removalControlPin;result:RemovalControlResult};
