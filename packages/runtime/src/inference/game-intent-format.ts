import {gamePlanningResponseFormat} from './game-response-format.ts';
import type {InferenceResponseFormat} from './port.ts';
import type * as G from '@lifestream/contracts/game-activity';

/** Explicit model wire protocol. The canonical effect proposal contract is unchanged. */
export type GameActionIntent=Pick<G.GameActionProposal,'buttons'|'durationFrames'|'maxWallMs'|'expectedVisibleOutcome'|'uncertainty'|'adviceRefs'|'reason'>&{
 schemaVersion:'1.0.0';recordType:'gameActionIntent';preconditions:{fieldId:string}[];
};
const original=(gamePlanningResponseFormat.json_schema.schema.anyOf as any[])[0];
const properties:Record<string,unknown>={schemaVersion:{const:'1.0.0'},recordType:{const:'gameActionIntent'}};
for(const name of ['buttons','durationFrames','maxWallMs','expectedVisibleOutcome','uncertainty','adviceRefs','reason'])properties[name]=structuredClone(original.properties[name]);
properties.preconditions={type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['fieldId'],properties:{fieldId:structuredClone(original.properties.preconditions.items.properties.fieldId)}}};
const format:InferenceResponseFormat={type:'json_schema',json_schema:{name:'game_action_intent_v1',schema:{anyOf:[{type:'object',additionalProperties:false,required:Object.keys(properties),properties},{type:'null'}]}}};
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export const gameIntentResponseFormat=freeze(format);
