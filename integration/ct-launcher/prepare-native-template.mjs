// Source preparation only. This reads fixed existing CT source/assets and emits
// no scope, session, native request, expiry, grant, process or live qualification.
import {createHash} from 'node:crypto';
import {readNativeFile,C72_IMAGE,C72_WRAPPER,C72_SECCOMP,C72_FRONTEND,C72_STATE,C72_SOURCES,C72_KNOWN_PINS,C72_CONTINUATION} from '../../packages/providers-bizhawk/src/c72-native-configuration.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function prepareCtNativeTemplate(){
 const files=[];
 const pin=(path,maximum=134217728)=>{const bytes=readNativeFile(path,maximum);try{const sha256=hash(bytes);files.push({path,bytes:bytes.length,sha256});return {path,sha256};}finally{bytes.fill(0);}};
 const frontend=pin(C72_FRONTEND);if(frontend.sha256!==C72_KNOWN_PINS.frontend)throw Error('Exact existing CT frontend source pin changed');
 const template={schemaVersion:'ct-native-template/1',image:C72_IMAGE,wrapper:pin(C72_WRAPPER),seccomp:pin(C72_SECCOMP),frontend,continuation:{path:C72_STATE,...C72_CONTINUATION},sources:Object.fromEntries(Object.entries(C72_SOURCES).map(([name,path])=>[name,pin(path,262144).sha256])),imagePins:Object.fromEntries(['mono','rom','core','controller','configFactory'].map(name=>[name,C72_KNOWN_PINS[name]])),romSha1:'de5822f4f2f7a55acb8926d4c0eaa63d5d989312',qualificationRef:'ct-launcher-control13:source-preparation-only-not-current-native-or-gameplay-qualification'};
 const bytes=Buffer.from(JSON.stringify(template)+'\n');
 return {template,bytes,sha256:hash(bytes),files,scopeCreated:false,currentNativeQualified:false,imagePinsFreshlyRequalified:false,limitation:'Existing expected image/ROM metadata retained; only listed host files were read and hashed. Main must regenerate against its exact final CT native sources and pin the installed owner-only template. No runtime facts or authority are supplied.'};
}
