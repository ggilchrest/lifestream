import { mkdtemp, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Own a fresh report outside connected repositories; never replace older evidence.
export async function createQualificationReport(report, { outputPath, forbiddenRoot, prefix }) {
  const path = outputPath ? resolve(outputPath) : join(await mkdtemp(join(tmpdir(), prefix)), 'report.json');
  const parent = await realpath(dirname(path));
  const root = await realpath(forbiddenRoot);
  const offset = relative(root, parent);
  if (!offset || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))) {
    throw new Error('Qualification reports must be outside the connected repository roots.');
  }
  const file = join(parent, basename(path));
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await handle.close();
  }
  let pending = Promise.resolve();
  return {
    path: file,
    save() {
      const content = JSON.stringify(report, null, 2) + '\n';
      const operation = pending.then(async () => {
        const temporary = `${file}.pending`;
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        try {
          await rename(temporary, file);
        } catch (error) {
          await unlink(temporary);
          throw error;
        }
      });
      pending = operation.catch(() => {});
      return operation;
    }
  };
}

// Raw transport exceptions can include credentials. Keep only known categories.
export function qualificationFailure(error) {
  const name = ['AssertionError', 'TimeoutError', 'AbortError'].includes(error?.name) ? error.name : 'OperationError';
  // AssertionError.message embeds actual/expected values, including raw SSE and
  // transport errors. The separately recorded observations are the safe detail.
  const operator = ['ok', 'match', 'doesNotMatch', 'strictEqual', 'notStrictEqual', 'deepStrictEqual'].includes(error?.operator) ? error.operator : 'assertion';
  const location = typeof error?.stack === 'string' ? error.stack.match(/qualify-s073-development\.mjs:(\d+):(\d+)/u) : null;
  return { name, ...(name === 'AssertionError' ? { message: 'Qualification assertion failed; inspect sanitized observations.', operator, ...(location ? { source: 'qualify-s073-development.mjs', line: Number(location[1]), column: Number(location[2]) } : {}) } : {}) };
}

const providerCodes = new Set(['deadline_exceeded', 'cancelled', 'inference_unavailable', 'response_limit', 'malformed_provider_event', 'invalid_canonical_request', 'replay_live_provider_forbidden', 'runtime_input_stale', 'runtime_context_changed', 'missing_provider_terminal']);
const safeCode = code => providerCodes.has(code) ? code : 'provider_error';

// Persist only the known synthetic event payloads. Never archive free-form
// provider error messages or unknown/malformed frames alongside those outputs.
export function qualificationEvents(text) {
  const fields = {
    'interaction.started': ['interactionId', 'sessionId', 'assistantId', 'provider'],
    'interaction.completed': ['interactionId', 'provider'],
    'message.delta': ['interactionId', 'text'],
    'input.manifest': ['schemaVersion', 'sections', 'tokenizer'],
  };
  return text.split(/\r?\n\r?\n/u).filter(frame => frame.trim()).map(frame => {
    const event = frame.match(/^event: (.+)$/mu)?.[1];
    if (event !== 'interaction.error' && !Object.hasOwn(fields, event ?? '')) return { event: 'unrecognized', omitted: true };
    try {
      const data = JSON.parse(frame.split(/\r?\n/u).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Malformed event');
      if (event === 'interaction.error') return { event, data: { code: safeCode(data.code), message: 'Provider or runtime operation failed; raw message omitted.' } };
      return { event, data: Object.fromEntries(fields[event].filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) };
    } catch {
      return { event, malformed: true };
    }
  });
}

// Persistence and cleanup are independent obligations. A failed report write
// must not retain credentials, prototypes, a server, or an owned SSH process.
export async function finishQualificationReport(report, save, cleanups) {
  const persist = async () => {
    try { await save(); }
    catch (error) { (report.persistenceFailures ??= []).push(qualificationFailure(error)); report.result = 'fail'; }
  };
  await persist();
  for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch (error) { (report.cleanupFailures ??= []).push(qualificationFailure(error)); report.result = 'fail'; }
  }
  await persist();
}

// A terminal failure is not generated content and must never establish a fence pass.
export async function holdQualificationText(hold, chunk) {
  if (!hold || hold.entered) return;
  if (chunk.kind === 'text' && chunk.text?.length) {
    hold.entered = true;
    hold.diagnostic.firstTextMs = performance.now() - hold.started;
    hold.enter();
    await hold.wait;
  } else if (chunk.kind === 'error' || chunk.kind === 'done') {
    hold.failure = chunk.kind === 'done' ? 'terminal_before_text' : safeCode(chunk.error?.code);
    hold.diagnostic.failure = hold.failure;
  }
}
