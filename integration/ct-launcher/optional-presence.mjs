// Trusted in-process owner ports only. This module reads no files, environment,
// device, key, model, identity, permission or consent and creates no owners.
// Keep the ordinary launcher call empty until a separate explicit composition
// supplies the existing qualified device/privacy owners.
export function createOptionalPresenceOptions(ports){
 if(ports===undefined||ports===null)return Object.freeze({});
 if(typeof ports!=='object'||Array.isArray(ports))throw Error('Invalid optional presence ports');
 const descriptors=Object.getOwnPropertyDescriptors(ports),keys=Reflect.ownKeys(descriptors);
 if(keys.some(key=>!['configuration','initiativeDestination'].includes(key)||!Object.hasOwn(descriptors[key],'value')))throw Error('Invalid optional presence ports');
 const configuration=descriptors.configuration?.value,destination=descriptors.initiativeDestination?.value;
 if(configuration===undefined){if(destination!==undefined)throw Error('Presence destination requires explicit configuration');return Object.freeze({});}
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration))throw Error('Invalid optional presence configuration');
 return Object.freeze({ubuntuPresence:configuration,...(destination===undefined?{}:{initiativeDestination:destination})});
}
