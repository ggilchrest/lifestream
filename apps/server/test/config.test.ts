import { createPwceDispatcher } from '../src/config/pwce.ts';
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, loadProfile, redactedDigest } from "../src/config/loader.ts";

const base = {
  profile: "test",
  providers: { inference: "fixture", memory: "fixture", stt: "fixture", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "fixture" },
  storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" },
  authority: { provider: "fixture", authentication: "fixture" },
  secretRefs: {}
} as const;

test("configuration precedence and redacted digest are deterministic", () => {
  const first = loadConfig({ defaults: base, profile: {}, environment: { storage: { databasePath: "env" } }, cli: { storage: { databasePath: "cli" }, secretRefs: { token: { kind: "env", name: "TOKEN" } } } });
  const second = loadConfig({ defaults: base, profile: {}, environment: { storage: { databasePath: "env" } }, cli: { storage: { databasePath: "cli" }, secretRefs: { token: { kind: "env", name: "TOKEN" } } } });
  assert.equal(first.storage.databasePath, "cli");
  assert.equal(redactedDigest(first), redactedDigest(second));
  const changed = loadConfig({ defaults: base, profile: {}, environment: {}, cli: { providers: { memory: "fixture" }, providerRequirements: { world: "required" } } });
  assert.notEqual(redactedDigest(first), redactedDigest(changed));
});

test("profiles are explicit and include provider requirements", () => {
  assert.equal(loadProfile("test").profile, "test");
  assert.equal(loadProfile("local-dev").providerRequirements.world, "optional");
  assert.equal(loadProfile("ai5090").providers.inference, "ai5090-development");
  assert.equal(loadProfile("ai5090").providers.stt, "nemo-speech");
  assert.equal(loadProfile("ai5090").providers.tts, "voxcpm");
  assert.equal(loadProfile("ai5090").sttProfile?.model, "nvidia/nemotron-speech-streaming-en-0.6b");
  assert.equal(loadProfile("ai5090").ttsProfile?.model, "openbmb/VoxCPM2");
  const mac = loadProfile("mac-local");
  assert.equal(mac.providers.inference, "ollama-mac-local");
  assert.equal(mac.inferenceProfile?.servedModelName, "qwen3.5:2b-q4_K_M");
  assert.equal(mac.providers.tts, "voxcpm");
  assert.equal(mac.ttsProfile?.model, "mlx-community/VoxCPM2-4bit");
  assert.equal(mac.providers.stt, "moonshine-mlx");
  assert.equal(mac.sttProfile?.model, "moonshine-ai/moonshine-tiny");
  assert.equal(mac.providerRequirements.stt, "required");
});

test("unknown keys and non-fixture test providers fail closed", () => {
  assert.throws(() => loadConfig({ defaults: { ...base, unknown: true }, profile: {}, environment: {}, cli: {} }), /unknown configuration key/);
  assert.throws(() => loadConfig({ defaults: { ...base, providers: { ...base.providers, memory: "live" } }, profile: {}, environment: {}, cli: {} }), /requires fixture/);
  assert.throws(() => loadConfig({ defaults: { ...base, profile: "mac-local", inferenceProfile: { runtime: "Ollama", runtimeVersion: "0.31.1", model: "Qwen", modelRevision: "r", servedModelName: "qwen", quantization: "q4", contextLength: 1, endpoint: "http://127.0.0.1:11434", developmentOnly: true } }, profile: {}, environment: {}, cli: {} }), /runtime artifact digest/);
});

test('PWCE configuration binds World, mode, sites and an environment credential without local grants',()=>{
 const pwceProfile={endpoint:'http://127.0.0.1:12345',worldRef:'world.synthetic',executionEnvironmentRef:'replay',siteRefs:['home.one'],principalRef:'agent.synthetic',lifestreamEnvironmentId:'deployment.synthetic',tokenSecretRef:'gateway'};
 const input={...base,profile:'local-dev',providers:{...base.providers,world:'pwce',capability:'pwce'},authority:{provider:'pwce',authentication:'local-password'},secretRefs:{gateway:{kind:'env',name:'PWCE_SYNTHETIC_TOKEN'}},pwceProfile};
 const load=(extra:Record<string,unknown>={})=>loadConfig({defaults:{...input,...extra},profile:{},environment:{},cli:{}});
 assert.equal(load().pwceProfile?.timeoutMs,1000);
 for(const change of [{token:'plaintext'},{endpoint:'http://user:secret@localhost'},{endpoint:'http://localhost?token=secret'},{executionEnvironmentRef:'deployment.synthetic'},{siteRefs:['home.one','home.one']},{timeoutMs:5001},{maximumPromptBytes:16385},{tokenSecretRef:'missing'}]) assert.throws(()=>load({pwceProfile:{...pwceProfile,...change}}));
 assert.throws(()=>load({providers:{...input.providers,capability:'fixture'}}),/standalone/);
 assert.throws(()=>load({authority:{...input.authority,provider:'fixture'}}),/standalone/);
 assert.throws(()=>load({profile:'test'}),/fixture/);
 assert.throws(()=>load({providers:base.providers}),/explicit/);
});


test('PWCE dispatcher composition requires distinct host-only credentials without changing discovery configuration',()=>{
 const profile={endpoint:'http://127.0.0.1:12345',worldRef:'world.synthetic',executionEnvironmentRef:'normal',siteRefs:['home.one'],principalRef:'agent.synthetic',lifestreamEnvironmentId:'deployment.synthetic',tokenSecretRef:'gateway'};
 const input={...base,profile:'local-dev',providers:{...base.providers,world:'pwce',capability:'pwce'},authority:{provider:'pwce',authentication:'local-password'},secretRefs:{gateway:{kind:'env',name:'PWCE_AGENT'},dispatcher:{kind:'env',name:'PWCE_DISPATCHER'}},pwceProfile:profile};
 const load=(change:Record<string,unknown>={})=>loadConfig({defaults:{...input,...change},profile:{},environment:{},cli:{}});
 const noRead=new Proxy({}, {get(){throw new Error('unexpected secret read');}});
 assert.equal(createPwceDispatcher(load(),noRead),undefined);
 const configured={...profile,dispatcherTokenSecretRef:'dispatcher'};
 const config=load({pwceProfile:configured});
 assert.ok(createPwceDispatcher(config,{PWCE_AGENT:'a'.repeat(40),PWCE_DISPATCHER:'b'.repeat(40)}));
 for(const environment of [{},{PWCE_AGENT:'a'.repeat(40)},{PWCE_AGENT:'a'.repeat(40),PWCE_DISPATCHER:'a'.repeat(40)},{PWCE_AGENT:'a'.repeat(40),PWCE_DISPATCHER:'short'}])assert.throws(()=>createPwceDispatcher(config,environment));
 for(const ref of ['gateway','missing','',42])assert.throws(()=>load({pwceProfile:{...profile,dispatcherTokenSecretRef:ref}}));
 assert.throws(()=>load({pwceProfile:configured,secretRefs:{...input.secretRefs,dispatcher:{kind:'env',name:'PWCE_AGENT'}}}));
 assert.throws(()=>load({pwceProfile:configured,authority:{provider:'pwce',authentication:'fixture'}}));
 assert.throws(()=>load({pwceProfile:{...configured,dispatcherToken:'plaintext'}}));
 assert.equal(JSON.stringify(config).includes('a'.repeat(40)),false);
});
