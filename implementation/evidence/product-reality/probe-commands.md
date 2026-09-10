# Product-reality focused probe commands

Audit revision: `a7adeb28ddc438e3c31aaf2d2e7867c36660745e`

These probes used only fixtures, in-memory databases, or isolated paths under `/tmp`. They did not call production services. The observations are summarized in `persistence-and-integrity-probes.json`.

## Controlled same-path server restart

The audit created `/tmp/lifestream-product-reality/persistence-server.mjs` with this exact transient helper source:

```js
import { createLifestreamServer } from "/Users/gg/Documents/Development/Agentic/lifestream/apps/server/dist/index.js";

const port = Number(process.env.AUDIT_PORT ?? 3833);
const databasePath = process.env.AUDIT_DATABASE_PATH ?? "/tmp/lifestream-product-reality/persistence-audit.sqlite";
const app = createLifestreamServer({
  port,
  config: {
    profile: "local-dev",
    providers: {
      inference: "fixture",
      memory: "fixture",
      stt: "fixture",
      tts: "fixture",
      world: "fixture",
      capability: "fixture",
      renderer: "fixture",
      clock: "system"
    },
    storage: {
      databasePath,
      artifactDirectory: "/tmp/lifestream-product-reality/persistence-artifacts"
    },
    authority: { provider: "fixture", authentication: "fixture" },
    secretRefs: {}
  }
});

await app.start();
console.log(JSON.stringify({ event: "started", port, databasePath, health: app.health }));
const stop = () => void app.shutdown().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
```

The exact multi-session sequence was as follows. The initial file assertion ran in the controlling shell and exited 0:

```sh
test ! -e /tmp/lifestream-product-reality/persistence-audit.sqlite
```

PTY session A started the blocking server command:

```sh
AUDIT_PORT=3833 AUDIT_DATABASE_PATH=/tmp/lifestream-product-reality/persistence-audit.sqlite node /tmp/lifestream-product-reality/persistence-server.mjs
```

While session A remained active, session B ran:

```sh
node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3833/api/interactions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"My favorite hot drink is jasmine tea."})}); console.log(JSON.stringify({status:r.status,body:await r.json()}));'
```

The first request returned HTTP 202 with `{"code":"accepted","message":"interaction admitted to bounded runtime"}`. Ctrl-C was then sent to session A; the server shut down and exited 0. Session B ran the first file check:

```sh
if test -e /tmp/lifestream-product-reality/persistence-audit.sqlite; then stat -f '%N %z bytes' /tmp/lifestream-product-reality/persistence-audit.sqlite; else echo 'database-file-absent'; fi
```

It printed `database-file-absent`. PTY session A then started the same blocking server command again:

```sh
AUDIT_PORT=3833 AUDIT_DATABASE_PATH=/tmp/lifestream-product-reality/persistence-audit.sqlite node /tmp/lifestream-product-reality/persistence-server.mjs
```

While session A remained active, session B ran:

```sh
node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3833/api/interactions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"Which beverage do I prefer?"})}); console.log(JSON.stringify({status:r.status,body:await r.json()}));'
```

The paraphrased request returned the same static HTTP 202 body. Ctrl-C was sent to session A; the second server process shut down and exited 0. Session B ran the final check:

```sh
if test -e /tmp/lifestream-product-reality/persistence-audit.sqlite; then stat -f '%N %z bytes' /tmp/lifestream-product-reality/persistence-audit.sqlite; else echo 'database-file-absent-after-second-stop'; fi
```

It printed `database-file-absent-after-second-stop`. No correction request was possible because the server exposes no memory admission, inspection, or correction route.

## Fresh migration inventory

```sh
node --experimental-strip-types --input-type=module -e 'import { Database } from "./packages/storage-sqlite/src/database.ts"; const db=new Database({path:":memory:"}); const migrations=db.migrate().map((r)=>r.id); const tables=db.connection.prepare("SELECT name,type FROM sqlite_master ORDER BY name").all().filter((r)=>r.type==="table").map((r)=>r.name); console.log(JSON.stringify({reportedMigrationIds:migrations,reportedHead:Math.max(...migrations),tables},null,2)); db.close();'
```

Exit 0. The reported migration IDs were 1, 11, 12, and 13; the reported numeric head was 13.

## Lexical versus paraphrased memory and repository recreation

```sh
node --experimental-strip-types --input-type=module -e 'import { FixtureMemoryProvider } from "./packages/providers-fixture/src/memory/provider.ts"; import { MemoryRepository } from "./packages/storage-sqlite/src/memory.ts"; const record={id:"memory-1",assistantId:"assistant-1",content:"My favorite hot drink is Earl Grey tea.",provenance:{source:"fixture"},lifecycle:{status:"active"},createdAt:"2026-09-08T00:00:00Z"}; const fixture=new FixtureMemoryProvider([record]); const exact=fixture.recall("assistant-1","Earl Grey",5).map((r)=>r.id); const paraphrase=fixture.recall("assistant-1","Which beverage do I prefer?",5).map((r)=>r.id); const first=new MemoryRepository(); first.save(record); const recreated=new MemoryRepository(); console.log(JSON.stringify({exactLexicalRecall:exact,paraphrasedSemanticRecall:paraphrase,recreatedRepositoryCount:recreated.list("assistant-1").length,fixtureMethods:Object.getOwnPropertyNames(Object.getPrototypeOf(fixture)),repositoryMethods:Object.getOwnPropertyNames(Object.getPrototypeOf(first))},null,2));'
```

Exit 0. Exact lexical recall returned `memory-1`; paraphrased recall returned no records; the recreated repository count was 0.

## Profile activation and reopen consistency

```sh
node --experimental-strip-types --input-type=module -e 'import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { Database } from "./packages/storage-sqlite/src/database.ts"; import { AssistantProfileRepository } from "./packages/storage-sqlite/src/assistant-profile.ts"; const dir=mkdtempSync(join(tmpdir(),"lifestream-profile-audit-")); const path=join(dir,"state.sqlite"); const base=(revision,profileId)=>({schemaVersion:"2.0.0",assistantId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",profileId,revision,status:"draft",corePersona:{canonicalName:"Fixture A",identityStatement:"Fixture identity",values:["fixture"],prohibitions:["fixture"],relationshipBoundaries:["fixture"],styleBoundaries:["fixture"]},adaptivePersonaPolicy:{dimensions:[]},createdAt:"2026-09-08T00:00:00Z",createdBy:"audit"}); let db=new Database({path}); db.migrate(); let repo=new AssistantProfileRepository(db); repo.create(base(1,"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")); repo.activate("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",null,"human","initial","2026-09-08T00:00:01Z"); repo.create(base(2,"cccccccc-cccc-cccc-cccc-cccccccccccc")); repo.activate("cccccccc-cccc-cccc-cccc-cccccccccccc",1,"human","revision two","2026-09-08T00:00:02Z"); db.close(); db=new Database({path}); db.migrate(); repo=new AssistantProfileRepository(db); const storageRows=db.connection.prepare("SELECT revision,status,profile_json AS profileJson FROM assistant_profiles ORDER BY revision").all().map((r)=>({revision:r.revision,columnStatus:r.status,jsonStatus:JSON.parse(r.profileJson).status})); const projected=repo.list("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").map((p)=>({revision:p.revision,status:p.status,assistantId:p.assistantId})); console.log(JSON.stringify({path,storageRows,repositoryListAfterReopen:projected},null,2)); db.close();'
```

Exit 0. Revision 1 had SQL status `superseded` but serialized status `active`; after reopen both projected revisions were `active`.

The direct-active bypass probe was:

```sh
node --experimental-strip-types --input-type=module -e 'import { Database } from "./packages/storage-sqlite/src/database.ts"; import { AssistantProfileRepository } from "./packages/storage-sqlite/src/assistant-profile.ts"; const db=new Database({path:":memory:"}); db.migrate(); const repo=new AssistantProfileRepository(db); const invalid={schemaVersion:"2.0.0",assistantId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",profileId:"dddddddd-dddd-dddd-dddd-dddddddddddd",revision:1,status:"active",createdAt:"2026-09-08T00:00:00Z",createdBy:"not-a-human-check"}; let accepted=false; let error=null; try { repo.create(invalid); accepted=true; } catch (value) { error=String(value); } const profiles=repo.list("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"); const auditCount=db.connection.prepare("SELECT COUNT(*) AS count FROM profile_activation_audit").get().count; console.log(JSON.stringify({schemaInvalidAndDirectActiveAccepted:accepted,error,storedProfile:profiles[0],activationAuditCount:auditCount},null,2)); db.close();'
```

Exit 0. It reported `schemaInvalidAndDirectActiveAccepted: true`, `error: null`, and `activationAuditCount: 0`.

## Configuration digest coverage

```sh
node --experimental-strip-types --input-type=module -e 'import { createLifestreamServer } from "./apps/server/src/index.ts"; const base={profile:"local-dev",providers:{inference:"fixture",memory:"fixture",stt:"fixture",tts:"fixture",world:"fixture",capability:"fixture",renderer:"fixture",clock:"system"},storage:{databasePath:"one.sqlite",artifactDirectory:"one"},authority:{provider:"fixture",authentication:"fixture"},secretRefs:{}}; const changed={...base,providers:{...base.providers,memory:"hindsight",inference:"sglang"},storage:{databasePath:"two.sqlite",artifactDirectory:"two"}}; const first=createLifestreamServer({config:base}).health.configurationDigest; const second=createLifestreamServer({config:changed}).health.configurationDigest; console.log(JSON.stringify({first,second,equal:first===second},null,2));'
```

Exit 0. Both digests were `ba2e17d5d9d8bb2ddf39a95e337125f6ecc426361ca88e87337cc39047e4f0e2`; `equal` was true.

## Vox wire-format mapping

```sh
node --experimental-strip-types --input-type=module -e 'import { VoxCpmProvider } from "./packages/providers-voxcpm/src/provider.ts"; const format={encoding:"pcm_s16le",sampleRateHz:16000,channels:1}; const delivery={interactionId:"i",segmentId:"s",decisionId:"d",decisionRevision:1,deliveryMode:"neutral",urgency:"normal",pace:.5,energy:.5}; const req={contractVersion:"2.0.0",deadlineAt:"2999-01-01T00:00:00Z",text:"x",segmentId:"s",format,voiceProfile:{voiceRef:"v",revision:1},decision:{decisionId:"d",revision:1},delivery}; const wire={encoding:"pcm_s16le",sampleRateHz:48000,channels:1}; const body=[{kind:"preAudio",sequence:0,requestId:"i:s",correlationId:"d",voiceBundleRevision:1,requestedDelivery:delivery,appliedDelivery:delivery,degradedDimensions:[],mappingRevision:"map",effectiveSynthesis:{},format:wire,runtimeRevision:"r",modelRevision:"m"},{kind:"data",sequence:1,sampleOffset:0,sampleCount:1,dataBase64:"AAA=",format:wire},{kind:"terminal",sequence:2,outcome:"completed",outputSamples:1,frameCount:1}].map(JSON.stringify).join("\n")+"\n"; const p=new VoxCpmProvider({baseUrl:"http://fixture",voiceBundleKey:"fixture-voice-design",voiceBundleRevision:1,runtimeRevision:"r",modelRevision:"m",mappingRevision:"map",fetch:async()=>new Response(body,{status:200})}); for await (const e of p.synthesize(req)) if(e.kind==="data") console.log(JSON.stringify({wireRate:48000,reportedFrameRate:e.frame.format.sampleRateHz}));'
```

Exit 0. It printed `{"wireRate":48000,"reportedFrameRate":16000}`.

## Voice segment identity

```sh
node --experimental-strip-types --input-type=module -e 'import {VoicePipeline} from "./packages/runtime/src/voice/pipeline.ts"; import {FixtureSpeechToTextProvider,FixtureTextToSpeechProvider} from "./packages/providers-fixture/src/voice/providers.ts"; import {FixturePlaybackSink} from "./packages/providers-fixture/src/voice/playback.ts"; const format={encoding:"pcm_s16le",sampleRateHz:16000,channels:1}; async function* audio(){yield {type:"frame",audioInputId:"a",frame:{frameId:"f",sequence:0,format,sampleOffset:0,sampleCount:2,dataBase64:"AAAA"}};yield {type:"end",audioInputId:"a",nextSequence:1,sampleCount:2}}; async function* inference(){yield "Hello";yield " world."}; const sink=new FixturePlaybackSink(4); const result=await new VoicePipeline(new FixtureSpeechToTextProvider(),inference,new FixtureTextToSpeechProvider(),sink).run({audio:audio(),format,speechRequest:{deadlineAt:"2999-01-01T00:00:00Z",now:()=>"2026-01-01T00:00:00Z"}}); console.log(JSON.stringify({status:result.status,segments:sink.played.map(x=>x.segmentId)}));'
```

Exit 0. It printed `{"status":"succeeded","segments":["segment-0","segment-0"]}`.

## Dreaming protected-operation enforcement

```sh
node --experimental-strip-types --input-type=module -e 'import { runDreaming } from "./packages/runtime/src/dreaming/run.ts"; import { validateProposal } from "./packages/runtime/src/dreaming/proposal-validator.ts"; import { applyProposal } from "./packages/runtime/src/dreaming/apply.ts"; const forbidden={id:"p-core",kind:"changeCorePersona",evidenceIds:["m1"]}; let runAccepted=false; let validatorAccepted=false; let applied=false; try { runDreaming(()=>[forbidden],{}); runAccepted=true; } catch {} try { validateProposal(forbidden); validatorAccepted=true; } catch {} try { applyProposal(forbidden,1,1); applied=true; } catch {} console.log(JSON.stringify({forbiddenCorePersonaProposalRunAccepted:runAccepted,standaloneValidatorAccepted:validatorAccepted,applyHelperAccepted:applied},null,2));'
```

Exit 0. All three values were true.
