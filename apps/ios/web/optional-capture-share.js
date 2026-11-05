// Always ask the native exporter: retained evidence may exist after capture stops.
export async function shareOptionalCapture(native,notice){
 notice.textContent='Preparing optional capture…';
 try{
  if(typeof native.shareAuditDiagnostics!=='function')throw Error('Audit sharing is unavailable in this app.');
  const result=await native.shareAuditDiagnostics();notice.textContent=result.shared?'Optional capture shared.':'Optional capture sharing cancelled.';
 }catch(error){
  const allowed=['The audit file could not be prepared on this device.','Open the app and close other panels before sharing diagnostics.','Audit sharing is unavailable in this app.'];
  notice.textContent=error?.message==='There are no audit events to share yet.'?'No optional capture is available to share. Capture is separate from the diagnostic log and must be explicitly enabled.':allowed.includes(error?.message)?error.message:'Optional capture sharing could not be opened. Try again.';
 }
}
