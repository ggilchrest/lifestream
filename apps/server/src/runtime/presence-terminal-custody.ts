/** Trusted in-process revocation bookkeeping, never an authority grant.
 * Every participating owner must invalidate synchronously BEFORE changing a
 * covered fact, including changes caused by configured callbacks or clocks.
 * Missing canonical participation leaves availability unavailable. */
export const presenceTerminalCustodyRoles=Object.freeze(['availability','producer','retention','enrollment','authentication','session','configuration','host'] as const);
export type PresenceTerminalCustodyRole=typeof presenceTerminalCustodyRoles[number];
declare const handleBrand:unique symbol;
declare const ticketBrand:unique symbol;
export type PresenceTerminalCustodyHandle={readonly [handleBrand]:true};
export type PresenceTerminalCustodyTicket={readonly [ticketBrand]:true};
/** Freeze this exact own-data map before installation. No supplied getters/methods. */
export type PresenceTerminalCustodyOwners=Readonly<Record<PresenceTerminalCustodyRole,PresenceTerminalCustodyHandle>>;
type State={role:PresenceTerminalCustodyRole;generation:number;closed:boolean};
type Captured={owners:PresenceTerminalCustodyOwners;handles:readonly PresenceTerminalCustodyHandle[];generations:readonly number[]};
const states=new WeakMap<object,State>();
const maps=new WeakMap<object,readonly PresenceTerminalCustodyHandle[]>();
const tickets=new WeakMap<object,Captured>();
export function createPresenceTerminalCustodyOwner(role:PresenceTerminalCustodyRole):{handle:PresenceTerminalCustodyHandle;invalidate:()=>void;close:()=>void}{
 if(!presenceTerminalCustodyRoles.includes(role))throw new TypeError('Unknown presence custody role');
 const handle=Object.freeze({}) as PresenceTerminalCustodyHandle,state:State={role,generation:0,closed:false};states.set(handle,state);
 return Object.freeze({handle,invalidate:()=>{if(state.closed)return;if(state.generation===Number.MAX_SAFE_INTEGER){state.closed=true;return;}state.generation++;},close:()=>{state.closed=true;}});
}
/** Descriptor inspection is confined to capture, before any producing callback.
 * Frozen maps cannot replace handles after capture. Proxy traps may run here,
 * never in the final matcher; the original guards still follow capture. */
export function capturePresenceTerminalCustody(owners:unknown):PresenceTerminalCustodyTicket|null{
 try{
  if(!owners||typeof owners!=='object'||Object.isExtensible(owners))return null;
  const descriptors=Object.getOwnPropertyDescriptors(owners),keys=Reflect.ownKeys(descriptors);
  if(keys.length!==presenceTerminalCustodyRoles.length||keys.some(k=>typeof k!=='string'||!presenceTerminalCustodyRoles.includes(k as PresenceTerminalCustodyRole)))return null;
  const handles:PresenceTerminalCustodyHandle[]=[],generations:number[]=[];
  for(const role of presenceTerminalCustodyRoles){const d=descriptors[role];if(!d||!Object.hasOwn(d,'value')||d.writable!==false||d.configurable!==false||!d.value||typeof d.value!=='object')return null;
   const state=states.get(d.value);if(!state||state.role!==role||state.closed)return null;handles.push(d.value);generations.push(state.generation);
  }
  const stable=Object.freeze(handles);maps.set(owners,stable);
  const ticket=Object.freeze({}) as PresenceTerminalCustodyTicket;tickets.set(ticket,{owners:owners as PresenceTerminalCustodyOwners,handles:stable,generations:Object.freeze(generations)});return ticket;
 }catch{return null;}
}
/** Terminal match has no supplied property access, getter, iterator, method or
 * clock callback. It compares only private registered identities and epochs. */
export function matchesPresenceTerminalCustody(ticket:PresenceTerminalCustodyTicket,owners:PresenceTerminalCustodyOwners):boolean{
 const captured=tickets.get(ticket),handles=maps.get(owners);if(!captured||captured.owners!==owners||!handles)return false;
 for(let i=0;i<presenceTerminalCustodyRoles.length;i++){const handle=captured.handles[i]!;if(handles[i]!==handle)return false;const state=states.get(handle);if(!state||state.closed||state.role!==presenceTerminalCustodyRoles[i]||state.generation!==captured.generations[i])return false;}
 return true;
}

/** Canonical Auth/Session bookkeeping is a partial participation receipt only.
 * It cannot qualify availability without the remaining six actual owners. */
export type PresenceAuthSessionCustodyOwners=Readonly<Pick<PresenceTerminalCustodyOwners,'authentication'|'session'>>;
declare const authSessionTicketBrand:unique symbol;
export type PresenceAuthSessionCustodyTicket={readonly [authSessionTicketBrand]:true};
const authSessionTickets=new WeakMap<object,{owners:PresenceAuthSessionCustodyOwners;handles:readonly PresenceTerminalCustodyHandle[];generations:readonly number[]}>();
export function capturePresenceAuthSessionCustody(owners:PresenceAuthSessionCustodyOwners):PresenceAuthSessionCustodyTicket|null{
 try{
  if(!owners||typeof owners!=='object'||Object.isExtensible(owners))return null;
  const d=Object.getOwnPropertyDescriptors(owners);if(Reflect.ownKeys(d).length!==2)return null;
  const handles:PresenceTerminalCustodyHandle[]=[],generations:number[]=[];
  for(const role of ['authentication','session'] as const){const field=d[role];if(!field||!Object.hasOwn(field,'value')||field.writable!==false||field.configurable!==false)return null;
   const value=field.value;if(!value||typeof value!=='object')return null;const state=states.get(value);if(!state||state.role!==role||state.closed)return null;handles.push(value);generations.push(state.generation);
  }
  const ticket=Object.freeze({}) as PresenceAuthSessionCustodyTicket;authSessionTickets.set(ticket,{owners,handles:Object.freeze(handles),generations:Object.freeze(generations)});return ticket;
 }catch{return null;}
}
/** No original owner methods, descriptors or configured clocks execute here. */
export function matchesPresenceAuthSessionCustody(ticket:PresenceAuthSessionCustodyTicket,owners:PresenceAuthSessionCustodyOwners):boolean{
 const captured=authSessionTickets.get(ticket);if(!captured||captured.owners!==owners)return false;
 for(const [i,role] of (['authentication','session'] as const).entries()){const state=states.get(captured.handles[i]!);if(!state||state.closed||state.role!==role||state.generation!==captured.generations[i])return false;}
 return true;
}
