import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Model compliance is telemetry, not application acceptance. Privacy and prepared
// input assertions remain in the owning tests and must still fail normally.
export function identifierObservation(label, identifier, output) {
  if (!/^[A-Za-z0-9_]+$/u.test(identifier)) throw new Error('Expected an opaque identifier');
  const pattern = `(?<![A-Za-z0-9_])${identifier}(?![A-Za-z0-9_])`;
  const outcome = new RegExp(pattern, 'u').test(output) ? 'exact'
    : new RegExp(pattern, 'iu').test(output) ? 'capitalizationOnly' : 'missingCompleteIdentifier';
  return { label, identifier, outcome, outputSha256: createHash('sha256').update(output).digest('hex') };
}

export function modelQuality(samples) {
  const counts = { exact: 0, capitalizationOnly: 0, missingCompleteIdentifier: 0 };
  for (const sample of samples) {
    if (!Object.hasOwn(counts, sample.outcome)) throw new Error('Unknown model outcome');
    counts[sample.outcome]++;
  }
  return { schemaVersion: '1.0.0', blocking: false, samples, counts, total: samples.length,
    identifierPresenceRate: samples.length ? (counts.exact + counts.capitalizationOnly) / samples.length : null,
    exactMatchRate: samples.length ? counts.exact / samples.length : null };
}

export async function persistModelQuality(repository, report) {
  const evidence = report.checks?.find(check => check.evidence?.modelQuality)?.evidence ?? report.joinedEvidence;
  if (!evidence?.modelQuality) return;
  const entry = { slice: report.slice, collectedAt: report.collectedAt, sourceRevision: report.sourceRevision,
    selectedProfileSha256: report.selectedProfileSha256, applicationResult: report.result,
    modelQuality: evidence.modelQuality };
  const bytes = JSON.stringify(entry, null, 2) + '\n';
  const id = createHash('sha256').update(bytes).digest('hex');
  const directory = join(repository, '.lifestream', 'model-quality');
  await mkdir(directory, { recursive: true });
  // Identical reports have the same identity; another observation run gets a new
  // timestamp and file. Keep the local history even if a later app check fails.
  await writeFile(join(directory, id + '.json'), bytes);
}
