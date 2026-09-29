import test from 'node:test';
import assert from 'node:assert/strict';
import {compareHistoricalAppearance,appearanceComparisonCurrent,appearanceComparisonPolicy,type AppearanceComparisonInput,type HistoricalAppearanceEpisode} from '../src/visual-memory/comparison.ts';

const day=86_400_000,now=Date.parse('2026-09-29T12:00:00Z');
const owner={assistantId:'assistant',principalId:'owner',relationshipId:'relationship',subjectRef:'confirmed-subject'};
function episode(index:number,patch:Partial<HistoricalAppearanceEpisode>={}):HistoricalAppearanceEpisode {
  return {scope:{...owner},episodeId:`episode-${index}`,episodeRevision:1,lifecycleRevision:2,lifecycle:'active',sourceFamily:`source-${index}`,sessionId:`session-${index}`,capturedAtMs:now-index*day,retainedUntilMs:now+day,attribution:'verifiedBinding',headVisibility:'usable',hat:'present',limitations:['Interpretation only; raw media was not retained.'],...patch};
}
function input(episodes:readonly HistoricalAppearanceEpisode[]=[episode(1),episode(2),episode(3)]):AppearanceComparisonInput {
  return {scope:{...owner},nowMs:now,calendarTimeZone:'UTC',relationshipAuthorized:true,visualHistoryAllowed:true,audiencePermits:true,subjectBindingCurrent:true,coverage:{fromMs:now-30*day,toMs:now,complete:true,totalEpisodes:episodes.length,boundaryRevision:'memory:42'},current:{scope:{...owner},observationId:'current-observation',sourceFamily:'current-source',sessionId:'current-session',capturedAtMs:now-100,freshUntilMs:now+5900,attribution:'userConfirmed',headVisibility:'usable',hat:'notVisible',limitations:['Visible head only; no claim about outside the frame.']},episodes};
}
const compare=(value:AppearanceComparisonInput)=>compareHistoricalAppearance(value,revision=>revision==='memory:42');

test('three independent retained sessions support a qualified current comparison despite old capture expiry',()=>{
  const value=input([episode(1),episode(2),episode(3),episode(4,{hat:'notVisible'})]),result=compare(value);
  assert.equal(result.status,'qualified');assert.equal(result.numerator,3);assert.equal(result.denominator,4);assert.equal(result.supportingSessions,3);assert.equal(result.supportingDates,3);
  assert.deepEqual(result.counterexamples,['episode-4']);assert.equal(result.claimScope,'observedSessionsOnly');
  assert.equal(result.window!.fromMs,now-30*day);assert.equal(result.window!.toMs,now);assert.equal(result.policyRevision,appearanceComparisonPolicy.revision);
  assert.ok(result.dependencies.every(item=>item.capturedAtMs+6000<now),'historical eligibility follows retention, not current-view expiry');
  assert.equal(result.freshUntilMs,value.current.freshUntilMs);assert.equal(appearanceComparisonCurrent(result,now),true);
});

test('all contrary and usable-head unknown opportunities count against support',()=>{
  const contrary=compare(input([episode(1),episode(2),episode(3),episode(4,{hat:'notVisible'}),episode(5,{hat:'notVisible'})]));
  assert.equal(contrary.reason,'insufficient_support');assert.equal(contrary.numerator,3);assert.equal(contrary.denominator,5);assert.deepEqual(contrary.counterexamples,['episode-4','episode-5']);
  const unknown=compare(input([episode(1),episode(2),episode(3),episode(4,{hat:'unknown',limitations:['A prose mention of a hat is not a classification.']}),episode(5,{hat:'unknown'})]));
  assert.equal(unknown.reason,'insufficient_support');assert.equal(unknown.denominator,5);assert.deepEqual(unknown.counterexamples,[],'unknown is not absence');assert.equal(unknown.opportunities.filter(item=>item.classification==='unknown').length,2);
});

test('unusable head coverage is disclosed but is neither support nor absence',()=>{
  const result=compare(input([episode(1),episode(2),episode(3),episode(4,{headVisibility:'occluded',hat:'notVisible'}),episode(5,{headVisibility:'outOfFrame',hat:'present'}),episode(6,{headVisibility:'unknown'})]));
  assert.equal(result.status,'qualified');assert.equal(result.numerator,3);assert.equal(result.denominator,3);assert.equal(result.excluded.headUnusable,3);assert.deepEqual(result.counterexamples,[]);
  assert.equal(result.dependencies.length,6,'retained missing-coverage sources remain revision dependencies');
});

test('repeated frames, summaries and correlated sessions cannot manufacture independent votes',()=>{
  const oneFamily=compare(input([episode(1),episode(2,{sourceFamily:'source-1'}),episode(3,{sourceFamily:'source-1'})]));
  assert.equal(oneFamily.reason,'insufficient_history');assert.equal(oneFamily.numerator,1);assert.equal(oneFamily.denominator,1);
  const duplicates=compare(input([episode(1),episode(2),episode(3),episode(4,{sourceFamily:'source-1',sessionId:'session-1'})]));
  assert.equal(duplicates.status,'qualified');assert.equal(duplicates.numerator,3,'a duplicate remains one opportunity');
  const mixed=compare(input([episode(1),episode(2),episode(3),episode(4,{sourceFamily:'source-1',hat:'notVisible'})]));
  assert.equal(mixed.status,'unavailable');assert.equal(mixed.numerator,2);assert.equal(mixed.denominator,3);assert.deepEqual(mixed.counterexamples,['episode-4']);
  const bridge=compare(input([episode(1),episode(2),episode(3),episode(4,{sourceFamily:'source-1',sessionId:'session-2',headVisibility:'occluded'})]));
  assert.equal(bridge.numerator,2,'unusable rows still preserve known correlation between source families/sessions');assert.equal(bridge.status,'unavailable');
});

test('supporting dates and sessions are selected together, including a session crossing midnight',()=>{
  const crossing=compare(input([episode(1,{sessionId:'long-session'}),episode(2,{sessionId:'long-session'}),episode(3,{capturedAtMs:now-day}),episode(4,{capturedAtMs:now-2*day})]));
  assert.equal(crossing.supportingSessions,3);assert.equal(crossing.supportingDates,2);assert.equal(crossing.reason,'insufficient_history');
  const sameDate=compare(input([episode(1),episode(2,{capturedAtMs:now-day-1000}),episode(3,{capturedAtMs:now-day-2000})]));
  assert.equal(sameDate.supportingDates,1);assert.equal(sameDate.status,'unavailable');
  const dates=input([episode(1,{capturedAtMs:Date.parse('2026-09-27T23:00:00Z')}),episode(2,{capturedAtMs:Date.parse('2026-09-28T01:00:00Z')}),episode(3,{capturedAtMs:Date.parse('2026-09-29T01:00:00Z')})]);
  assert.equal(compare(dates).status,'qualified');assert.equal(compare({...dates,calendarTimeZone:'America/Chicago'}).supportingDates,2,'the caller supplies the calendar rather than an inferred operator timezone');
});

test('excluded identity bridges still constrain independence without exposing ineligible content',()=>{
  for(const patch of [{attribution:'unknown'},{lifecycle:'superseded'},{lifecycle:'forgotten'},{retainedUntilMs:now}] as const){
    const bridge=episode(4,{...patch,sourceFamily:'source-1',sessionId:'session-2',headVisibility:'unknown',hat:'unknown',limitations:['ERASED_OR_UNATTRIBUTED_SENTINEL']}),result=compare(input([episode(1),episode(2),episode(3),bridge]));
    assert.equal(result.status,'unavailable');assert.equal(result.numerator,2);assert.equal(result.denominator,2,'source/session bridge prevents two correlated rows voting separately');
    assert.equal(result.dependencies.some(item=>item.episodeId===bridge.episodeId),false);assert.equal(result.opportunities.some(item=>item.episodeIds.includes(bridge.episodeId)),false);assert.equal(JSON.stringify(result).includes('ERASED_OR_UNATTRIBUTED_SENTINEL'),false);
  }
});

test('current-family correlation propagates through original sessions before historical voting',()=>{
  for(const patch of [{},{attribution:'unknown'},{lifecycle:'superseded'},{lifecycle:'forgotten'}] as const){
    const bridge=episode(4,{...patch,sourceFamily:'current-source',sessionId:'session-1',headVisibility:'unknown',hat:'unknown'}),result=compare(input([episode(1),episode(2),episode(3),bridge]));
    assert.equal(result.status,'unavailable');assert.equal(result.numerator,2);assert.equal(result.denominator,2);assert.ok(result.excluded.currentSource>=1);
    assert.equal(result.dependencies.some(item=>item.episodeId==='episode-1'||item.episodeId==='episode-4'),false);
  }
  const transitive=compare(input([episode(1),episode(2),episode(3),episode(4,{sourceFamily:'current-source',sessionId:'bridge-session',lifecycle:'forgotten'}),episode(5,{sourceFamily:'source-1',sessionId:'bridge-session',attribution:'unknown'})]));
  assert.equal(transitive.numerator,2);assert.equal(transitive.status,'unavailable','multiple excluded bridges cannot disconnect current evidence');
});

test('complete coverage, exact window and capacity are required even if the returned top results all support',()=>{
  const value=input();
  for(const coverage of [{...value.coverage,complete:false},{...value.coverage,totalEpisodes:4},{...value.coverage,fromMs:now-29*day},{...value.coverage,toMs:now-1}]){
    const result=compare({...value,coverage});assert.equal(result.reason,'incomplete_coverage');assert.equal(result.numerator,0);assert.deepEqual(result.dependencies,[]);
  }
  const tooMany=compare(input(Array.from({length:129},(_,index)=>episode(index+1,{capturedAtMs:now-day}))));assert.equal(tooMany.reason,'capacity_exceeded');assert.deepEqual(tooMany.dependencies,[]);
  assert.equal(compare(input([episode(1),episode(2),episode(3,{capturedAtMs:now-30*day})])).status,'qualified','lower window boundary is inclusive');
  assert.equal(compare(input([episode(1),episode(2),episode(3,{capturedAtMs:now-30*day-1})])).reason,'invalid_input','malformed queried windows are not silently filtered');
});

test('foreign scope, withdrawn permissions and unsupported subject attribution expose no history',()=>{
  for(const key of ['assistantId','principalId','relationshipId','subjectRef'] as const){
    const value=input([episode(1),episode(2),episode(3,{scope:{...owner,[key]:'foreign'}})]),result=compare(value);
    assert.equal(result.reason,'scope_unavailable');assert.equal(result.denominator,0);assert.deepEqual(result.dependencies,[]);assert.equal(result.scope,null);
    assert.equal(compare({...input(),current:{...input().current,scope:{...owner,[key]:'foreign'}}}).reason,'scope_unavailable');
  }
  for(const key of ['relationshipAuthorized','visualHistoryAllowed','audiencePermits','subjectBindingCurrent'] as const)assert.equal(compare({...input(),[key]:false}).reason,'scope_unavailable');
  const unattributed=compare(input([episode(1),episode(2),episode(3,{attribution:'unknown'})]));assert.equal(unattributed.status,'unavailable');assert.equal(unattributed.excluded.unattributed,1);assert.equal(unattributed.dependencies.length,2);
});

test('a current absence comparison needs positive fresh head coverage and supported attribution',()=>{
  const value=input();
  for(const patch of [{headVisibility:'occluded'},{headVisibility:'outOfFrame'},{headVisibility:'unknown'},{attribution:'unknown'},{hat:'unknown'},{hat:'present'},{capturedAtMs:now+1},{freshUntilMs:now},{freshUntilMs:now+6001}] as const){
    const result=compare({...value,current:{...value.current,...patch}});assert.equal(result.reason,'current_unavailable');assert.deepEqual(result.dependencies,[]);
  }
  const duplicateCurrent=compare(input([episode(1),episode(2),episode(3,{sessionId:'current-session'})]));assert.equal(duplicateCurrent.status,'unavailable');assert.equal(duplicateCurrent.excluded.currentSource,1);
});

test('correction, forgetting and retention expiry recompute support instead of reviving old evidence',()=>{
  for(const lifecycle of ['corrected','superseded','forgotten','expired','needsReview'] as const){
    const result=compare(input([episode(1),episode(2),episode(3,{lifecycle,lifecycleRevision:3})]));assert.equal(result.status,'unavailable');assert.equal(result.numerator,2);assert.equal(result.excluded.notRetained,1);assert.equal(result.dependencies.some(item=>item.episodeId==='episode-3'),false);
  }
  const expired=compare(input([episode(1),episode(2),episode(3,{retainedUntilMs:now})]));assert.equal(expired.status,'unavailable');assert.equal(expired.excluded.notRetained,1);
  const corrected=compare(input([episode(1),episode(2),episode(3,{hat:'notVisible',episodeRevision:2,lifecycleRevision:3})]));assert.equal(corrected.numerator,2);assert.deepEqual(corrected.counterexamples,['episode-3']);
});

test('authentic comparison guards fence lifecycle changes, source expiry and rollback permanently',()=>{
  let revision='memory:42';const value=input([episode(1),episode(2),episode(3,{retainedUntilMs:now+500})]);
  const result=compareHistoricalAppearance(value,pinned=>pinned===revision);assert.equal(result.status,'qualified');assert.equal(result.freshUntilMs,now+500);
  assert.equal(appearanceComparisonCurrent({...result},now),false);assert.equal(appearanceComparisonCurrent(result,now+499),true);
  revision='memory:43';assert.equal(appearanceComparisonCurrent(result,now+499),false);revision='memory:42';assert.equal(appearanceComparisonCurrent(result,now+499),false,'an older restored boundary cannot resurrect a retired result');
  const expires=compare(value);assert.equal(appearanceComparisonCurrent(expires,now+500),false);assert.equal(appearanceComparisonCurrent(expires,now),false);
  const rollback=compare(input());assert.equal(appearanceComparisonCurrent(rollback,now-1),false);assert.equal(appearanceComparisonCurrent(rollback,now),false);
  const laterRollback=compare(input());assert.equal(appearanceComparisonCurrent(laterRollback,now+100),true);assert.equal(appearanceComparisonCurrent(laterRollback,now+50),false);assert.equal(appearanceComparisonCurrent(laterRollback,now+101),false,'rollback inside the original interval also retires the result');
});

test('monotonic elapsed time bounds result reuse even when the supplied wall clock is frozen',t=>{
  let mono=500;const mocked=t.mock.method(performance,'now',()=>mono),value=input();
  const result=compare(value);assert.equal(appearanceComparisonCurrent(result,now),true);
  mono+=5900;assert.equal(appearanceComparisonCurrent(result,now),false);mono=500;assert.equal(appearanceComparisonCurrent(result,now),false);
  const duringPreparation=compareHistoricalAppearance(value,()=>{mono+=3000;return true;});assert.equal(duringPreparation.reason,'current_unavailable','preparation cannot refresh the capture lifetime');
  mocked.mock.restore();
});

test('boundary failure during computation or later use fails closed, including exceptions',()=>{
  let calls=0;const changed=compareHistoricalAppearance(input(),()=>++calls===1);assert.equal(changed.reason,'boundary_changed');assert.deepEqual(changed.dependencies,[]);
  assert.equal(compareHistoricalAppearance(input(),()=>{throw Error('unavailable lifecycle');}).reason,'boundary_changed');
  let throws=false;const result=compareHistoricalAppearance(input(),()=>{if(throws)throw Error('revoked');return true;});throws=true;assert.equal(appearanceComparisonCurrent(result,now),false);
});

test('reentrant guard calls cannot revive retirement or overwrite a later observed time',()=>{
  for(const nestedNow of [now-1,now+200]){
    let result:ReturnType<typeof compare>|undefined,entered=false,nested:boolean|undefined;
    result=compareHistoricalAppearance(input(),()=>{if(result&&!entered){entered=true;nested=appearanceComparisonCurrent(result,nestedNow);}return true;});
    assert.equal(result.status,'qualified');assert.equal(appearanceComparisonCurrent(result,now+100),false,'outer use is also retired by reentrancy');assert.equal(nested,false);
    assert.equal(appearanceComparisonCurrent(result,now+150),false);assert.equal(appearanceComparisonCurrent(result,now+201),false,'retirement persists after the callback no longer reenters');
  }
});

test('comparison is immutable and never interprets mutable input prose as an appearance classification',()=>{
  const value=input(),result=compareHistoricalAppearance(value,()=>{(value.episodes[0] as any).hat='notVisible';return true;});
  assert.equal(result.status,'qualified');assert.equal(result.numerator,3,'the comparison uses one detached validated snapshot');
  (value.episodes[0]!.limitations as string[])[0]='A later different description';assert.equal(result.dependencies[0]!.limitations[0],'Interpretation only; raw media was not retained.');
  assert.throws(()=>{(result.counterexamples as string[]).push('fake');},TypeError);assert.throws(()=>{(result.scope as any).subjectRef='foreign';},TypeError);
});

test('malformed times, missing lifecycle, hostile getters/proxies and oversized inputs fail without reading behavior',()=>{
  for(const patch of [{nowMs:NaN},{nowMs:Infinity},{nowMs:-1},{calendarTimeZone:'not/a-timezone'}])assert.equal(compare({...input(),...patch}).reason,'invalid_input');
  const missing=input();delete (missing.episodes[0] as any).lifecycleRevision;assert.equal(compare(missing).reason,'invalid_input');
  const duplicated=episode(1);assert.equal(compare(input([duplicated,duplicated,episode(3)])).reason,'invalid_input');
  let reads=0;const getter=input();Object.defineProperty(getter.episodes[0],'hat',{get(){reads++;return 'present';}});assert.equal(compare(getter).reason,'invalid_input');assert.equal(reads,0);
  const proxy=new Proxy(input(),{ownKeys(){reads++;throw Error('must not inspect proxy');}});assert.equal(compare(proxy).reason,'invalid_input');assert.equal(reads,0);
  const coercion=input();(coercion.episodes[0] as any).hat={toString(){reads++;return 'present';}};assert.equal(compare(coercion).reason,'invalid_input');assert.equal(reads,0);
  assert.equal(compare(input([episode(1,{limitations:['x'.repeat(513)]}),episode(2),episode(3)])).reason,'invalid_input');
  const excessive=input(Array.from({length:128},(_,index)=>episode(index+1,{capturedAtMs:now-day,limitations:Array(8).fill('x'.repeat(512))})));assert.equal(compare(excessive).reason,'capacity_exceeded');
});
