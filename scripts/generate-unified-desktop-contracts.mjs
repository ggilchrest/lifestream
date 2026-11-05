import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
const names = ['conversation-history', 'shell-preferences', 'effective-subject', 'desktop-session'];
if (process.argv.slice(2).some(argument => argument !== '--check')) throw Error('Use --check, or no arguments to regenerate.');
const contracts = {};
for (const name of names) {
  const bytes = await readFile(new URL(`packages/contracts/src/schemas/${name}.schema.json`, root));
  const schema = JSON.parse(bytes), prefix = `https://lifestream.dev/contracts/${name}/`;
  if (!schema.$id?.startsWith(prefix)) throw Error(`Unexpected published schema identity: ${name}`);
  const schemaVersion = schema.$id.slice(prefix.length);
  const records = Object.values(schema.$defs ?? {}).filter(record => record.properties?.schemaVersion);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(schemaVersion) || !records.length || records.some(record => record.properties.schemaVersion.const !== schemaVersion)) throw Error(`Inconsistent published schema version: ${name}`);
  contracts[name] = {schemaId: schema.$id, schemaVersion, digest: createHash('sha256').update(bytes).digest('hex')};
}
const pins = '// Generated from published schemas; check with node scripts/generate-unified-desktop-contracts.mjs --check.\n'
  + 'export const unifiedDesktopConsumerPins = Object.freeze({\n'
  + names.map(name => `  ${JSON.stringify(name)}: Object.freeze(${JSON.stringify(contracts[name])})`).join(',\n') + '\n});\n';
const browserAdmission = `
export function admitUnifiedDesktopProducer(boundary, pin) {
  const expected = unifiedDesktopConsumerPins[boundary];
  if (!expected || !pin || typeof pin !== 'object' || Array.isArray(pin)) return false;
  const fields = Object.getOwnPropertyDescriptors(pin);
  return Reflect.ownKeys(fields).length === 3 && ['schemaId','schemaVersion','digest'].every(key => fields[key] && 'value' in fields[key] && fields[key].value === expected[key]);
}
`;
const outputs = new Map([
  ['packages/contracts/src/unified-desktop.lock.json', JSON.stringify({schemaVersion: '1.0.0', contracts}, null, 2) + '\n'],
  ['packages/contracts/src/unified-desktop.consumer-pins.ts', pins],
  ['apps/daily-web/owners/unified-desktop-contracts.js', pins + browserAdmission],
]);
for (const [path, content] of outputs) {
  const url = new URL(path, root);
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== content) throw Error(`Stale generated contract pin: ${path}`);
  } else await writeFile(url, content);
}
console.log(process.argv.includes('--check') ? 'Published schemas and both generated consumer pins agree.' : 'Generated producer lock and consumer pins from published schemas.');
