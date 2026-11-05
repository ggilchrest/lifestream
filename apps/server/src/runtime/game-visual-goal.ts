import {isDeepStrictEqual} from 'node:util';
import type {ActivityScope,GameObservation} from '@lifestream/contracts/game-activity';

/** A stop-only goal over already qualified visible fields. No image/model
 * classification, controller authority, hidden coordinates or progress guesses. */
export function createDialogueMovementGoal(options:{scope:ActivityScope;manifestDigest:string;initialDialogue:string;displacement:number;current:(observation:GameObservation)=>boolean}){
 const scope=structuredClone(options.scope),digest=options.manifestDigest,text=options.initialDialogue,distance=options.displacement,current=options.current;
 if(!text||text.length>500||!Number.isSafeInteger(distance)||distance<1||distance>64||!/^[a-f0-9]{64}$/.test(digest))throw Error('Finite visible goal required');
 let phase:'initial'|'dialogue'|'movement'|'complete'|'unavailable'='initial',room:string|undefined,origin:{x:number;y:number}|undefined;
 const observe=(observation:GameObservation)=>{
  if(phase==='complete'||phase==='unavailable')return phase;
  if(!isDeepStrictEqual(scope,observation.scope)||!current(observation)){phase='unavailable';return phase;}
  const field=(id:string)=>observation.visibleState.find(f=>f.fieldId===id&&f.visibility==='visibleNow'&&f.lastObservedRef===observation.observationId&&f.timelineId===scope.timelineId&&f.manifestDigest===digest&&Date.parse(f.freshUntil)>Date.now())?.value;
  const scene=field('ct.ui.scene'),dialogue=field('ct.ui.dialogue.text'),x=field('ct.ui.player.x'),y=field('ct.ui.player.y');
  if(typeof scene!=='string'||typeof dialogue!=='string'||room!==undefined&&scene!==room){phase='unavailable';return phase;}
  if(phase==='initial'){if(dialogue!==text){phase='unavailable';return phase;}room=scene;phase='dialogue';return phase;}
  if(dialogue!==''){if(phase==='movement')phase='unavailable';return phase;}
  if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)){phase='unavailable';return phase;}
  if(!origin){origin={x:Number(x),y:Number(y)};phase='movement';return phase;}
  if(Math.max(Math.abs(Number(x)-origin.x),Math.abs(Number(y)-origin.y))>=distance)phase='complete';
  return phase;
 };
 return Object.freeze({observe,snapshot:()=>Object.freeze({phase,room,origin:origin?Object.freeze({...origin}):null,requiredDisplacement:distance})});
}

/** Stop-only movement goal for a separately prepared, reviewed closed-dialogue
 * starting frame. Preparation is not model gameplay and grants no authority. */
export function createVisibleMovementGoal(options:{scope:ActivityScope;manifestDigest:string;displacement:number;current:(observation:GameObservation)=>boolean}){
 const scope=structuredClone(options.scope),digest=options.manifestDigest,distance=options.displacement,current=options.current;
 if(!Number.isSafeInteger(distance)||distance<1||distance>64||!/^[a-f0-9]{64}$/.test(digest))throw Error('Finite visible goal required');
 let phase:'initial'|'movement'|'complete'|'unavailable'='initial',room:string|undefined,origin:{x:number;y:number}|undefined;
 const observe=(observation:GameObservation)=>{
  if(phase==='complete'||phase==='unavailable')return phase;
  if(!isDeepStrictEqual(scope,observation.scope)||!current(observation)){phase='unavailable';return phase;}
  const field=(id:string)=>observation.visibleState.find(f=>f.fieldId===id&&f.visibility==='visibleNow'&&f.lastObservedRef===observation.observationId&&f.timelineId===scope.timelineId&&f.manifestDigest===digest&&Date.parse(f.freshUntil)>Date.now())?.value;
  const scene=field('ct.ui.scene'),dialogue=field('ct.ui.dialogue.text'),x=field('ct.ui.player.x'),y=field('ct.ui.player.y');
  if(typeof scene!=='string'||!scene.trim()||dialogue!==''||room!==undefined&&scene!==room||!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||Number(x)<0||Number(y)<0){phase='unavailable';return phase;}
  if(!origin){room=scene;origin={x:Number(x),y:Number(y)};phase='movement';return phase;}
  if(Math.max(Math.abs(Number(x)-origin.x),Math.abs(Number(y)-origin.y))>=distance)phase='complete';
  return phase;
 };
 return Object.freeze({observe,snapshot:()=>Object.freeze({phase,room,origin:origin?Object.freeze({...origin}):null,requiredDisplacement:distance})});
}
