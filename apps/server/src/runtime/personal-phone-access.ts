/** Trusted composition only. This does not extend authentication or change room policy. */
export type PersonalPhoneAccessOptions={mode:'authenticatedSession';authenticatedAfterMs:number};
export function capturePersonalPhoneAccess(value:PersonalPhoneAccessOptions|undefined):Readonly<PersonalPhoneAccessOptions>|undefined {
  if(value===undefined)return undefined;
  if(!value||Object.keys(value).sort().join()!=='authenticatedAfterMs,mode'||value.mode!=='authenticatedSession'||!Number.isSafeInteger(value.authenticatedAfterMs)||value.authenticatedAfterMs<0)throw Error('Invalid personal phone access policy');
  return Object.freeze({...value});
}
