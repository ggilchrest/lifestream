// Only the fixed host registry supplies executable bytes. Package manifests
// cannot select a URL, import path, code body or alternate registry kind.
export async function loadTrustedPresentationAdapter(item,{retrieveAdapter,signal,importModule=url=>import(url),urlOwner=URL}={}){
 const registration=item?.trustedRuntime;
 if(item?.manifest?.schemaVersion!=='1.5.0'||item.manifest.worldDelta?.adapter!=='world-delta.v1'||registration?.kind!=='world-delta.v1'||Object.keys(registration).some(k=>!['kind','sha256','bytes'].includes(k))||!/^[a-f0-9]{64}$/.test(registration.sha256)||!Number.isSafeInteger(registration.bytes)||registration.bytes<1||registration.bytes>262144||typeof retrieveAdapter!=='function')throw Error('This appearance has no approved motion runtime.');
 signal?.throwIfAborted();const bytes=await retrieveAdapter(item,signal);signal?.throwIfAborted();if(bytes.byteLength!==registration.bytes)throw Error('Motion runtime size changed.');
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');signal?.throwIfAborted();if(hash!==registration.sha256)throw Error('Motion runtime digest changed.');
 let url;try{url=urlOwner.createObjectURL(new Blob([bytes],{type:'text/javascript'}));signal?.throwIfAborted();const module=await importModule(url);signal?.throwIfAborted();if(module.contract!=='world-delta.v1'||typeof module.createPresentationAdapter!=='function'||(Object.hasOwn(module,'ADAPTER_ID')&&module.ADAPTER_ID!=='world-delta.v1')||Object.keys(module).some(k=>!['contract','createPresentationAdapter','ADAPTER_ID'].includes(k)))throw Error('Unsupported motion runtime contract.');return module.createPresentationAdapter;}finally{if(url)urlOwner.revokeObjectURL(url);}
}
