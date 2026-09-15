import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const at = process.argv.indexOf('--producer-root');
if (at < 0 || !process.argv[at + 1]) throw new Error('usage: --producer-root <public PWCE checkout> [--write]');
const root = resolve(process.argv[at + 1]);
const manifest = JSON.parse(await readFile(join(root, 'contracts/gateway-dispatch/bundle-manifest.json'), 'utf8'));
const core = JSON.parse(await readFile(join(root, 'contracts/gateway/bundle-manifest.json'), 'utf8'));
const expectedPaths = ['contracts/gateway-dispatch/transport.json', 'contracts/gateway-dispatch/request.schema.json', 'contracts/gateway-dispatch/response.schema.json'];
const expectedCore = { bundleId: 'pwce-agent-gateway.bundle.v1', bundleVersion: '1.0.0', bundleDigest: '32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2' };
if (manifest.bundleId !== 'pwce-trusted-dispatch.bundle.v1' || manifest.bundleVersion !== '1.0.0' || manifest.dispatchProfileId !== 'pwce-trusted-dispatch.v1' || manifest.dispatchProfileVersion !== '1.0.0' || manifest.digestAlgorithm !== 'sha256-ordered-path-bytes-v1' || JSON.stringify(manifest.requiredGatewayBundle) !== JSON.stringify(expectedCore) || Object.entries(expectedCore).some(([key,value]) => core[key] !== value) || JSON.stringify(manifest.artifacts.map(a=>a.path)) !== JSON.stringify(expectedPaths)) throw new Error('unsupported public producer dependency');
const aggregate = createHash('sha256');
const schemaBytes = [];
for (const artifact of manifest.artifacts) {
  const bytes = await readFile(join(root, artifact.path));
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('producer artifact digest mismatch');
  aggregate.update(artifact.path).update('\0').update(bytes); schemaBytes.push(bytes);
}
if (aggregate.digest('hex') !== manifest.bundleDigest) throw new Error('producer aggregate digest mismatch');
const source = `// Generated only from the public PWCE dispatch bundle. Do not edit by hand.\nconst freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };\nexport const EXPECTED_PWCE_DISPATCH_BUNDLE = freeze(${JSON.stringify(manifest, null, 2)} as const);\nexport const PWCE_DISPATCH_REQUEST_SCHEMA = freeze(${JSON.stringify(JSON.parse(schemaBytes[1]), null, 2)} as const);\nexport const PWCE_DISPATCH_RESPONSE_SCHEMA = freeze(${JSON.stringify(JSON.parse(schemaBytes[2]), null, 2)} as const);\n`;
const output = 'packages/providers-pwce/src/dispatch-bundle.ts';
const matches = await readFile(output, 'utf8').catch(() => '') === source;
if (process.argv.includes('--write')) await writeFile(output, source);
else if (!matches) { process.exitCode = 1; }
console.log(JSON.stringify({ source: 'public-PWCE-contract', bundleDigest: manifest.bundleDigest, byteIdentical: matches || process.argv.includes('--write') }));
