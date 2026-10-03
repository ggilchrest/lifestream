'use strict';
// Closed, nonsecret diagnostics. Never log an exception message, cause, setup,
// response body, cookie, CSRF value or arbitrary native-provider detail.
const details=Object.freeze({
 session_unavailable:'Sign in in this native window, then check the connection again.',
 owner_required:'The current native session must belong to the owner.',
 administration_expired:'Native administration has expired. Sign in again in this window.',
 context_unavailable:'Review Session disclosure in this native window.',
 conversation_unavailable:'The current conversation is unavailable. Review Session disclosure.',
 audience_unavailable:'Audience privacy is protected. If you are alone, choose Only me — 5 minutes in this window. A backend restart clears that temporary declaration.',
 setup_required:'Select a reviewed finite game setup before starting.',
 setup_changed:'The selected game setup has changed. Select the reviewed setup again.',
 setup_invalid:'The selected game setup is incompatible with this application or its finite bounds.',
 setup_expired:'The selected game setup has expired. A fresh coordinated finite setup is required.',
 session_busy:'A game session operation is already in progress.',
 session_consumed:'This selected session has already been attempted or stopped. No automatic retry is performed.',
 session_changed:'The authenticated session or its disclosure context changed before Start.',
 native_start_failed:'The native game host could not attach. The session has been fenced; review its bounded startup evidence.',
 dialog_unavailable:'The connection dialog is unavailable. Review the recorded blocking reason.',
 setup_selection_failed:'The reviewed finite game setup could not be selected.'
});
function gameHostBlockingReason(error,fallback='native_start_failed'){
 try{const code=error?.code;if(typeof code==='string'&&Object.hasOwn(details,code))return code;}catch{/* Untrusted errors are not diagnostic data. */}
 return Object.hasOwn(details,fallback)?fallback:'native_start_failed';
}
function gameHostFailure(reason='session_unavailable',message='game_host_session_unavailable'){
 const error=Error(message);Object.defineProperty(error,'code',{value:gameHostBlockingReason(null,reason),enumerable:true});return error;
}
function gameHostBlockingDetail(reason){return details[gameHostBlockingReason(null,reason)];}
module.exports={gameHostBlockingReason,gameHostBlockingDetail,gameHostFailure};
