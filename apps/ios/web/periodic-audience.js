// A slow periodic read must not accumulate requests in the native connection pool.
// This does not cache audience authority: the caller still checks expiry independently.
export function periodicAudienceCheck(check,settled){
 let pending=false,disposed=false;
 return {
  tick(){if(disposed||pending)return false;pending=true;Promise.resolve().then(check).catch(()=>{}).finally(()=>{pending=false;if(!disposed)settled();});return true;},
  dispose(){disposed=true;},
 };
}
