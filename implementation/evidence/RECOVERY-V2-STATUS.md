# Recovery v2 technical status

**Literal-test follow-up:** the operator requested an explicit exact-text test with opaque synthetic identifiers. [Source commit](../../apps/control-web/test/relationship-administration.test.mjs) `8139470c2f756313c09dda0bdffbe1f9649e059e` uses `SYNPRJ_Q7M4`, supplied only through the approved preference. The fixture browser test passed. The [first selected-provider attempt](LS-S075-literal-development-1.json) timed out before admission; the [second attempt](LS-S075-literal-development-2.json) passed three consecutive literal replies and the pre-admission/other-Assistant negatives. Full qualification refresh and S081 remain pending. The snapshot below records the earlier Green Finch failure and is retained as history.

The run stops at a selected-provider qualification failure in **LS-S075 / LS-TEST-090**. It is not ready for combined S080/S081 Human review. All currently independent implementation and qualification work through S080 has been completed; S081 remains behind its failed prerequisite.

Tested implementation: `b74358aed81bcc8b20aea5c840180f9914ce41c3`. S080 implementation commit: `db55a4453d92bc4a9ae4daeef85b687c5ea42b94`. Source-bound qualifications identify their effective private specification commit and artifact hashes; the private metadata commit at collection was `a272ad464c3c3b681454af688d14d2b680ac79ea`. Later receipt/checkpoint commits are not falsely presented as the tested implementation.

## Exact blocker

[Current S075 failure](LS-S075-development-failed-resume-4.json) preserves the executed browser failure. After real authentication, selected-file review and admission, the actual prepared request contained the approved Green Finch project preference. A repeated ordinary “Give a concrete Python example.” reply returned a Finch example without the approved project label. The assertion for prepared input passed; the output assertion failed. The current qualification explicitly selects this failure and cannot fall back to an earlier passing S075 receipt.

This is an observed selected-provider behavior failure, not missing authentication, an unimplemented source-intake path, or an unavailable credential. Earlier imported-declaration clarification and repeated-use coverage remain in source. A separate S073 missing-numbering observation was preserved; a general output-structure precedence clarification subsequently passed three consecutive format checks. No retry was relabeled as erasing its historical failure.

A further reviewed investigation of the selected provider/request policy is needed to satisfy repeated ordinary preference use, followed by affected owner qualification. Model replacement, live configuration changes, longer deadlines, alternate backends, or weaker acceptance criteria have not been authorized or silently substituted. The next dependency-gated operation is the real rendered S081 joined journey, not another reconciliation.

## Owner and case evidence

| Owner | Cases (LS-TEST-) | Current status | Evidence |
|---|---|---|---|
| S052 | 069 | verified | Selected runtime streaming, cancellation, deadlines, limits, outage and replay |
| S062 / S063 / S069 | 080 / 081 / 087 | verified | Real password/session/admin/permission paths; rendered profile and memory lifecycle |
| S072 | 091 structural only | verified structural-contract | Private repository qualification and exact approved four-schema export; no blanket runtime claim |
| S071 | 089 | verified | Actual typed and synthetic audio self-context; selected-provider and logout fences |
| S073 | 092 / 093 / 094 / 096 / 100 | verified | Ordinary prepared context, three current-format observations, relevance, cache, correction and audience races |
| S074 | 101 | verified | Bounded selected-file intake, explicit per-item review/admission and replay protection |
| S075 | 090 plus runtime 091 obligations | blockedEnvironment | Real administration passes; selected-provider repeated imported preference use failed |
| S076 | 095 / 105 | verified | Rendered controls, actual request/reply inspector, named review/activation/rollback |
| S077 | 097 / 098 | verified | Five source-grounded lenses, duplicate versus contrary evidence, explicit review/reversal |
| S078 | 099 | verified | 36 actual selected-provider comparisons; separate held-out runs, rejection, promotion and rollback |
| S079 | 103 | verified contract/readiness | Synthetic consent/dataset/lineage/registry/routing/revocation; no training or learned-quality claim |
| S080 | 102 / 104 | implementationCompleteVerificationPending | Objective joined removal/restore/failure and actual text/audio fencing pass; combined Human review pending |
| S081 | 106 | not executed in this recovery | Current S075 dependency fails; historical fixture/static tests are not joined acceptance |

Current immutable qualifications and selectors are in this directory. Required case 091 runtime/security coverage remains assigned to the implemented authentication, subject/Assistant scope, User Profile/relationship separation, prompt/inspector, Lab, readiness and recovery owners; it does not derive from S072 schema success. Its final joined index remains incomplete with S081.

## Independent work and verification

- **267 source tests, 21 browser tests and 43 evidence-tooling tests pass.** Build, typecheck, lint, workspace consistency and whitespace checks pass. Private validation passes 527 structural vectors and 49 specification semantic cases; these do not prove runtime acceptance.
- Selected-provider reruns pass for S052, S071, S073, S076, S078 and both S080 harnesses at the tested source. S075 is the retained failed run.
- S080 checks cover distinct collection/processing/personalization/training/deletion/forgetting actions, source-dependent Builder jobs/candidates, records, native memory and pending correction payloads, shared User Profiles, insight/Lab/configuration payloads, caches, readiness datasets/adapters and idempotency responses. Current external tombstones fence old database restores. Missing currency withholds personalization; injected database cleanup failure supports explicit retry while ordinary conversation continues.
- Actual selected-provider text is fenced after forgetting; synthetic TTS→STT→inference→TTS also fences a held response with **zero late text or PCM** and completes the following audio turn. No physical microphone or playback was used. Timing includes browser/authentication/preparation overhead and is not a new general performance or physical latency claim.
- The prior concurrent browser run and the explicit stale-lineage test adjustment are preserved in [validation observations](LS-S080-validation-observations-resume-1.json).

## Reproduce the failing boundary

From the public repository root, with the existing approved host access and selected services available:

```sh
pnpm build
PLAYWRIGHT_MODULE=/Users/gg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/qualify-s075-development.mjs
```

This starts and removes isolated synthetic test services, uses the existing selected provider and prints a sanitized report. It is not a persistent Human review server. No test service is intentionally left running. The existing Human testing guide remains a historical fixture walkthrough, not current combined acceptance evidence.

Selected inference remains `ai5090`, SGLang `0.0.0.dev1+g5f55db35e`, served `qwen3.8-27b-local`, `RadixArk/Qwen3.8-27B-NVFP4` revision `319f741cce68d7914884900c138a1fbb70a42f30`, NVFP4, context 65536. Profile SHA-256 is `8ba50cc7fbb592ae5ed8c7547308e5d16f3603b262c4a4d8bdabc67e542da4fd`; it also pins the unchanged NeMo STT and VoxCPM2 TTS identities. Actual observations and configuration digests are retained in the selected development reports.

## Remaining boundaries

Human acceptance is pending and no combined demo is requested yet. S081's original bounded packet remains intact; its real joined browser/provider acceptance has not executed. S083 initiative and S084 Discovery remain later adopted scope. S082 real training/adapter serving, S065 training, and S056/S070 physical, perceptual, latency and product gates remain separate. Owner-local logical payload removal does not erase external exports/backups or prove weight unlearning; keep current safety currency outside database backups.

No push, deployment, provider restart, live configuration change, personal-data import or training occurred. Public/private/composition histories remain separate; the original dirty composition handoff and two untracked user artifacts remain uncommitted.
