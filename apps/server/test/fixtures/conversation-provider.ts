import type {InferenceProvider} from '@lifestream/runtime/inference';

/** Explicit task dispatch in scripted HTTP fixtures. Conversation assertions
 * must not mistake an optional extraction request for the Human reply. */
export function conversationFixtureProvider(provider:InferenceProvider):InferenceProvider{
 return {...provider,async *generate(request,context){
  if(request.scope.sessionId==='automatic-memory-worker'){
   const data=JSON.parse(request.sections.find(section=>section.kind==='userInput')!.content);
   yield {kind:'text',text:JSON.stringify({version:2,source:data.sourceIdentity,items:[]})};yield {kind:'done'};return;
  }
  yield* provider.generate(request,context);
 }};
}
