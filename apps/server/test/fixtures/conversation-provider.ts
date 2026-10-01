import type {InferenceProvider} from '@lifestream/runtime/inference';

/** Explicit task dispatch in scripted HTTP fixtures. Conversation assertions
 * must not mistake an optional extraction request for the Human reply. */
export function conversationFixtureProvider(provider:InferenceProvider):InferenceProvider{
 return {...provider,async *generate(request,context){
  if(request.scope.sessionId==='automatic-memory-worker'){
   yield {kind:'text',text:'{"items":[]}'};yield {kind:'done'};return;
  }
  yield* provider.generate(request,context);
 }};
}
