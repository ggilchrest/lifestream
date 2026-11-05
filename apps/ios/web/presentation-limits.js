// Encoded resource bounds; decoded GPU memory still requires device validation.
export const mobilePresentationLimits=Object.freeze({resourceBytes:128*1024*1024,packageBytes:256*1024*1024});
export function assertMobilePresentation(item){
 if(item?.id==='neutral'&&!item.manifest)return;
 const resources=item?.manifest?.resources;
 if(!Array.isArray(resources)||!resources.length||resources.length>256)throw Error('Invalid mobile appearance resources.');
 let total=0;
 for(const resource of resources){
  if(!Number.isSafeInteger(resource.bytes)||resource.bytes<1)throw Error('Invalid mobile appearance resource size.');
  if(resource.bytes>mobilePresentationLimits.resourceBytes)throw Error('This iOS build supports appearance resources up to 128 MiB each.');
  total+=resource.bytes;
  if(total>mobilePresentationLimits.packageBytes)throw Error('This iOS build supports appearance packages up to 256 MiB.');
 }
}
