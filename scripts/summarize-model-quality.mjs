import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifierObservation, modelQuality } from './model-quality-observations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['implementation/evidence', '.lifestream/model-quality'];
const runs = new Map(), incompleteHistory = [];
const legacyPolicy = JSON.parse(await readFile(join(root, 'implementation/evidence/LS-S075-model-observation-policy-1.json')));
const retainedLegacy = new Map((legacyPolicy.legacyObservedReplies ?? []).map(item => [item.path, item]));
for (const directory of directories) {
  let names;
  try { names = await readdir(join(root, directory)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || (directory === directories[0] && !/^LS-S(?:075|081)-.*development.*\.json$/u.test(name))) continue;
    const path = join(directory, name), bytes = await readFile(join(root, path)), report = JSON.parse(bytes);
    if (!report.collectedAt || !report.sourceRevision) continue;
    const evidence = report.checks?.find(check => check.evidence?.observations)?.evidence ?? report.joinedEvidence;
    let quality = report.modelQuality ?? evidence?.modelQuality;
    if (!quality && evidence?.selectedProvider) {
      const samples = [];
      for (const observation of evidence.observations ?? []) {
        if (typeof observation.output !== 'string' || !observation.output) continue;
        const prepared = observation.preparedMemory?.content ?? observation.request?.sections?.find(section => section.kind === 'preparedMemory')?.content ?? '';
        for (const identifier of ['SYNPRJ_Q7M4', 'SYNPRJ_R6T8']) if (prepared.includes(identifier)) samples.push(identifierObservation(observation.label, identifier, observation.output));
      }
      if (samples.length) quality = modelQuality(samples);
    }
    const source = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
    const legacy = retainedLegacy.get(path);
    if (!quality?.total && legacy) {
      if (legacy.sha256 !== source.sha256) throw new Error('Legacy observation digest changed');
      quality = modelQuality(legacy.samples);
      incompleteHistory.push({ ...source, reason: legacy.note, coverage: legacy.coverage, retainedRepliesIncludedInDenominator: legacy.samples.length });
    }
    if (!quality?.total) {
      if (report.result === 'fail') incompleteHistory.push({ ...source, applicationResult: report.result,
        reason: 'Legacy failure has no complete retained per-reply observations. Do not invent successes or include it in the reply-rate denominator.' });
      continue;
    }
    const id = `${report.slice}:${report.sourceRevision}:${report.collectedAt}`;
    const existing = runs.get(id);
    if (existing) { existing.sources.push(source); continue; }
    runs.set(id, { id, sourceRevision: report.sourceRevision, collectedAt: report.collectedAt,
      selectedProfileSha256: report.selectedProfileSha256, applicationResult: report.result ?? report.applicationResult,
      sources: [source], modelQuality: quality });
  }
}
const observedRuns = [...runs.values()].sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
console.log(JSON.stringify({ schemaVersion: '1.0.0', scope: 'Nonblocking opaque-identifier model compliance; complete retained observations only',
  policy: 'Exact and capitalization-only presence are reported separately. Missing or altered complete identifiers remain visible model misses. Privacy, prepared input and application completion remain required.',
  aggregate: modelQuality(observedRuns.flatMap(run => run.modelQuality.samples)), runs: observedRuns, incompleteHistory,
  limitations: ['Repeated replies from the same run are correlated; these rates are not an independent statistical estimate.',
    'Legacy runs may lack individual replies. No whole-history failure rate is inferred from incomplete records.',
    'Local journal and committed report copies are deduplicated by slice, source revision and collection timestamp.'] }, null, 2));
