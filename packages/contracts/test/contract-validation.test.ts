import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createContractValidator } from "../src/validator.ts";

test("compiles every exported schema and rejects unknown schema IDs", () => {
  const validator = createContractValidator();
  assert.equal(validator.schemaIds().length, 26);
  assert.equal(validator.validate("unknown", {}).valid, false);
});

test("approved relationship export is byte-bound and retains both prepared-context versions", () => {
  const lock = JSON.parse(readFileSync(new URL("../../../spec-lock.json", import.meta.url), "utf8")) as { additionalExports: Array<{ artifacts: Array<{ publicPath: string; schemaId: string; sha256: string }> }> };
  const validator = createContractValidator();
  const artifacts = lock.additionalExports[0]!.artifacts;
  assert.equal(artifacts.length, 5);
  for (const artifact of artifacts) {
    const bytes = readFileSync(new URL(`../../../${artifact.publicPath}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    assert.equal(JSON.parse(bytes.toString()).$id, artifact.schemaId);
    assert.ok(validator.schemaIds().includes(artifact.schemaId));
    assert.equal(validator.validate(artifact.schemaId, {}).valid, false);
  }
  assert.ok(validator.schemaIds().includes("https://lifestream.dev/contracts/prepared-context/1.0.0"));
  assert.ok(validator.schemaIds().includes("https://lifestream.dev/contracts/prepared-context/2.0.0"));
});

// Public synthetic inputs; private structural fixtures are not exported.
test("approved extension exports compile and reject forged or unknown request fields", () => {
  const validator = createContractValidator();
  const receipt = JSON.parse(readFileSync(new URL("../../../implementation/evidence/S083-S084-SCHEMA-EXPORT-2.json", import.meta.url), "utf8")) as { artifacts: Array<{ path: string; schemaId: string; sha256: string }> };
  for (const artifact of receipt.artifacts) {
    const bytes = readFileSync(new URL(`../../../${artifact.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    assert.ok(validator.schemaIds().includes(artifact.schemaId));
  }
  for (const api of ["initiative-api", "understanding-api"]) {
    const id = `https://lifestream.dev/contracts/${api}/1.0.0`;
    const request = { schemaVersion: "1.0.0", operation: "inspect" };
    assert.equal(validator.validate(id, request).valid, true);
    for (const extra of [{ authority: true }, { subjectId: "another-user" }, { schemaVersion: "2.0.0" }, { operation: "enableLive" }]) {
      assert.equal(validator.validate(id, { ...request, ...extra }).valid, false);
    }
  }
});

test("shared compiled schemas keep caller results, schema lists and inputs independent", () => {
  const first=createContractValidator(),second=createContractValidator(),id="https://lifestream.dev/contracts/understanding-api/1.0.0";
  const invalid={schemaVersion:"1.0.0",operation:"inspect",privatePayload:"SYNTHETIC_PRIVATE_VALUE"},before=JSON.stringify(invalid);
  const failure=first.validate(id,invalid),saved=structuredClone(failure);
  assert.equal(failure.valid,false);assert.doesNotMatch(JSON.stringify(failure),/SYNTHETIC_PRIVATE_VALUE/);
  assert.equal(second.validate(id,{schemaVersion:"1.0.0",operation:"inspect"}).valid,true);assert.deepEqual(failure,saved);assert.equal(JSON.stringify(invalid),before);
  failure.errors[0]!.message="caller mutation";assert.notEqual(second.validate(id,invalid).errors[0]!.message,"caller mutation");
  const ids=first.schemaIds();ids.splice(0);assert.equal(second.schemaIds().length,26);
  first.validate=()=>({valid:true,errors:[]});assert.equal(second.validate('unknown',{}).valid,false);
});


test('experiential schema is exactly exported and rejects authority, unknown variants and over-bound learning',()=>{
 const lock=JSON.parse(readFileSync(new URL('../../../spec-lock.json',import.meta.url),'utf8')),entry=lock.additionalExports.find((x:{slice:string})=>x.slice==='LS-S086');assert.equal(entry.artifacts.length,1);const artifact=entry.artifacts[0],bytes=readFileSync(new URL('../../../'+artifact.publicPath,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
 const v=createContractValidator(),id=artifact.schemaId,reset={schemaVersion:'1.0.0',operation:'reset',expectedRevision:0};assert.equal(v.validate(id,reset).valid,true);for(const change of [{authority:true},{operation:'train'},{expectedRevision:-1},{schemaVersion:'2.0.0'}])assert.equal(v.validate(id,{...reset,...change}).valid,false);
 const change={dimension:'attentionGardening',delta:.05,episodeRefs:['episode-a','episode-b'],confidence:.8,reason:'Synthetic independent outcomes'};assert.equal(v.validate(id+'#/$defs/ChangeProposal',change).valid,true);for(const patch of [{delta:.05001},{dimension:'protectedTraitAversion'},{unreviewedCoreChange:true}])assert.equal(v.validate(id+'#/$defs/ChangeProposal',{...change,...patch}).valid,false);
});
