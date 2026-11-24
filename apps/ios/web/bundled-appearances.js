// Only packaged same-origin bytes reach the shared renderer. Never fall back to server assets.
export async function bundledAppearances() {
 const response=await fetch('./bundled-appearances.json',{credentials:'omit',redirect:'error'});
 if(!response.ok)throw Error('Bundled appearances are unavailable. Rebuild the app.');
 const value=await response.json();
 if(value.schemaVersion!=='1.0.0'||!Array.isArray(value.packages)||value.packages.length>16)throw Error('Invalid bundled appearance catalog.');
 return value;
}
export async function bundledResource(route,signal) {
 const adapter='/api/runtime/v1/presentation/adapters/';
 if(route.startsWith(adapter)){
  const match=/^world-delta\.v1\/([a-z0-9][a-z0-9._-]{0,63})\/([a-f0-9]{64})$/.exec(route.slice(adapter.length));
  if(!match||match[1]==='.'||match[1]==='..')throw Error('Invalid bundled motion runtime path.');
  const response=await fetch('./appearances/adapters/world-delta.v1/'+match[1]+'/'+match[2]+'.js',{signal,credentials:'omit',redirect:'error'});
  if(!response.ok)throw Error('Bundled motion runtime unavailable. Rebuild the app.');
  return response.arrayBuffer();
 }
 const prefix='/api/runtime/v1/presentation/resources/';
 if(!route.startsWith(prefix))throw Error('Appearance is not bundled.');
 const parts=route.slice(prefix.length).split('/');
 if(parts.length<2||parts.some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9._-]+$/.test(part)))throw Error('Invalid bundled resource path.');
 const response=await fetch('./appearances/'+parts.join('/'),{signal,credentials:'omit',redirect:'error'});
 if(!response.ok)throw Error('Bundled appearance resource unavailable. Rebuild the app.');
 return response.arrayBuffer();
}
