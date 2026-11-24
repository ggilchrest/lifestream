// Native transport observations only: no saved settings, privacy or mic input.
const states={
 disconnected:new Set(['unconfigured','signed_out','authentication_required','network_unavailable','service_unavailable','unavailable']),
 checking:new Set(['connecting','restoring','unverified','verification_expired']),
 connected:new Set(['verified'])
};
const labels={unconfigured:'Connection: not configured',signed_out:'Connection: signed out',connecting:'Connection: connecting',restoring:'Connection: restoring',verified:'Connection: connected, recently verified',unverified:'Connection: status unavailable',verification_expired:'Connection: awaiting fresh verification',network_unavailable:'Connection: lost',service_unavailable:'Connection: server unavailable',authentication_required:'Connection: sign in required',unavailable:'Connection: unavailable'};
export function createConnectionIndicator(root,label){
 let revision=-1;
 const show=(state,reason)=>{root.dataset.state=state;root.title=labels[reason];label.textContent=labels[reason]};
 show('disconnected','unconfigured');
 const unavailable=()=>{if(revision<0)show('checking','unverified')};
 function update(value){
  if(!value||Object.keys(value).length!==4||value.schemaVersion!=='1.0.0'||!Number.isSafeInteger(value.revision)||value.revision<0||!Object.hasOwn(states,value.state)||!states[value.state].has(value.reason)){unavailable();return false}
  if(value.revision<revision)return false;
  revision=value.revision;show(value.state,value.reason);return true;
 }
 return {update,unavailable};
}
