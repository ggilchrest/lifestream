import {types as nodeTypes} from 'node:util';
/** Closed, non-authorizing metadata from one original sourceAvailable call. */
export type NativeSourceWitness=Readonly<{stage:string;predicate:string;ageMs?:number;exceptionClass?:string}>;
export type NativeSourceCapture=(value:NativeSourceWitness)=>void;
const checks:Readonly<Record<string,readonly string[]>>={"client-current":["scope_equal","scope_current","installation_current","native_source_current"],"client-refresh":["read_refresh_deadline","refresh_rejected"],"boundary":["boundary_current","threw"],"source":["source_pins","source_wall_lease","source_monotonic_lease","source_execution_lifetime","source_current","source_proof_absent","source_proof_closed","source_proof_stale"],"owned-scope":["scope","child_pid","child_exit","child_signal","owned_custody","wake_proof_missing"],"files":["file_stat","file_regular","file_symlink","file_size","file_realpath","file_digest"],"snapshot":["snapshot_stat","snapshot_read_parse","snapshot_regular","snapshot_symlink","snapshot_size_min","snapshot_size_max","snapshot_realpath","snapshot_schema","snapshot_record","snapshot_scope","snapshot_pins","snapshot_provider","snapshot_version","snapshot_system","snapshot_rom","snapshot_sequence_integer","snapshot_sequence_regressed","snapshot_monotonic_finite","snapshot_monotonic_regressed","snapshot_frame_integer","snapshot_frame_negative","snapshot_checked_finite","snapshot_checked_future","snapshot_buttons_available","snapshot_buttons"],"custody-pre":["custody_clock_read","clock_changed","native_lease_expired","child_unavailable","cid_or_running_unavailable","inspect_clock_changed","inspect_not_fresh","child_pid_present","child_exit_null","child_signal_null","cid_present","verified_running_true","wall_not_regressed","monotonic_not_regressed","clock_latch_current","monotonic_before_expiry","wall_before_expiry"],"custody-read":["custody_read_parse"],"custody-post":["custody_clock_read","clock_changed","native_lease_expired","inspect_clock_changed","inspect_not_fresh","continuation_changed","receipt_identity_or_pins_changed","receipt_sequence_invalid","receipt_time_invalid","receipt_future","receipt_stale","receipt_time_regressed","process_identity_changed","receipt_sequence_stalled","wake_receipt_changed","receipt_schema_matches","receipt_invocation_matches","receipt_image_matches","receipt_scope_digest_matches","receipt_pins_digest_matches","receipt_source_pins_match","receipt_image_pins_match","receipt_viewable_true","receipt_startup_paused_true","receipt_pid_integer","receipt_pid_positive","receipt_start_ticks_integer","receipt_start_ticks_positive","receipt_sequence_integer","receipt_sequence_positive","receipt_sequence_not_regressed","process_start_ticks_match","process_pid_matches","process_configuration_matches","receipt_config_sha_shape","wall_not_regressed","monotonic_not_regressed","clock_latch_current","monotonic_before_expiry","wall_before_expiry"],"lifetime-pre":["state_lookup","wall_clock_read","monotonic_clock_read","not_retired","wall_finite","monotonic_finite","wall_not_regressed","monotonic_not_regressed","wall_before_expiry","monotonic_before_expiry","check_identity_matches","signal_identity_matches","signal_not_aborted","check_returned_true"],"lifetime-post":["wall_clock_read","monotonic_clock_read","not_retired","wall_finite","monotonic_finite","wall_not_regressed","monotonic_not_regressed","wall_before_expiry","monotonic_before_expiry","check_identity_matches","signal_identity_matches","signal_not_aborted"]};
const throwOnly=new Set(['refresh_rejected','threw','file_stat','snapshot_stat','snapshot_read_parse','custody_clock_read','custody_read_parse','state_lookup','wall_clock_read','monotonic_clock_read']);
const classes=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','Other']);
export function nativeSourceWitness(value:unknown):NativeSourceWitness|undefined{
 try{
  if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return;const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return;
  const keys=Reflect.ownKeys(value);if(keys.length<2||keys.length>4||keys.some(key=>typeof key!=='string'||!['stage','predicate','ageMs','exceptionClass'].includes(key)))return;
  const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!d.enumerable||!Object.hasOwn(d,'value'))return;out[key as string]=d.value;}
  if(typeof out.stage!=='string'||!Object.hasOwn(checks,out.stage)||typeof out.predicate!=='string'||!checks[out.stage]!.includes(out.predicate))return;
  if(Object.hasOwn(out,'ageMs')&&(!['inspect_not_fresh','receipt_stale','receipt_sequence_stalled','source_proof_stale'].includes(String(out.predicate))||!Number.isSafeInteger(out.ageMs)||Number(out.ageMs)<0||Number(out.ageMs)>600001))return;
  if(Object.hasOwn(out,'exceptionClass')&&(typeof out.exceptionClass!=='string'||!classes.has(out.exceptionClass)))return;
  if(throwOnly.has(String(out.predicate))&&!Object.hasOwn(out,'exceptionClass'))return;
  if(Object.hasOwn(out,'exceptionClass')&&Object.hasOwn(out,'ageMs'))return;
  return Object.freeze(out) as NativeSourceWitness;
 }catch{return;}
}
export function captureNativeSource(capture:NativeSourceCapture|undefined,value:NativeSourceWitness):void{if(!capture)return;try{const closed=nativeSourceWitness(value);if(closed)capture(closed);}catch{}}
export const nativeSourceAge=(value:number):number=>Math.min(600001,Math.max(0,Math.trunc(value)));
export function nativeSourceException(error:unknown):string{
 try{if(!error||typeof error!=='object'||nodeTypes.isProxy(error))return 'Other';let p=Object.getPrototypeOf(error);for(let n=0;p&&n<16;n++){if(nodeTypes.isProxy(p))return 'Other';for(const [name,type] of [['TypeError',TypeError],['RangeError',RangeError],['ReferenceError',ReferenceError],['SyntaxError',SyntaxError],['URIError',URIError],['EvalError',EvalError],['Error',Error]] as const)if(p===type.prototype)return name;p=Object.getPrototypeOf(p);}}catch{}return 'Other';
}

/** Optional request-local frame refusal metadata; never authority or raw errors. */
export type FrameApprovalWitness=Readonly<{stage:string;predicate:string;approvalPublished:boolean;exceptionClass?:string}>;
export type FrameApprovalCapture=(value:FrameApprovalWitness)=>void;
const frameChecks:Readonly<Record<string,readonly string[]>>={
 'composition':['frame_owner_absent','composition_current_false','composition_current_threw','frame_read_threw','frame_absent'],
 'backend':['coordination_wait_threw','composition_approval_threw','post_approval_status_threw'],
 'frame-source':['native_source_unavailable','observation_absent','screenshot_count','custody_read_threw','screenshot_identity','snapshot_unavailable'],
 'approval-identity':['pending_absent','body_absent','body_keys','request_identity','confirmation_digest','ordinary_gameplay_confirmation','protected_menu_confirmation','pending_expired','frame_absent','scope_identity','png_identity','frame_number','png_bytes_digest','screenshot_identity','identity_threw'],
 'approval-pixels':['pixel_decode_threw','dimensions_changed','black_frame','scene_decode_threw','scene_not_ordinary'],
 'approval-retention':['authority_read_threw','retention_not_finite','retention_expired','captured_time_not_finite','captured_time_future'],
 'approval-publication':['manifest_build_threw','exclusive_write_threw','rename_threw','temporary_cleanup_threw','return_manifest_threw']
};
export function captureFrameApproval(capture:FrameApprovalCapture|undefined,value:FrameApprovalWitness):void{
 if(!capture)return;
 try{
  if(!value||nodeTypes.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return;
  const keys=Reflect.ownKeys(value);if(keys.some(k=>typeof k!=='string'||!['stage','predicate','approvalPublished','exceptionClass'].includes(k))||keys.length<3||keys.length>4)return;
  const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!d.enumerable||!Object.hasOwn(d,'value'))return;out[key as string]=d.value;}
  if(typeof out.stage!=='string'||typeof out.predicate!=='string'||typeof out.approvalPublished!=='boolean'||!(frameChecks[out.stage]?.includes(out.predicate)||checks[out.stage]?.includes(out.predicate)))return;
  if(Object.hasOwn(out,'exceptionClass')&&(typeof out.exceptionClass!=='string'||!classes.has(out.exceptionClass)))return;
  capture(Object.freeze(out) as FrameApprovalWitness);
 }catch{}
}
