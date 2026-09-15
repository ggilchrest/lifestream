import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { ValidateFunction, AsyncValidateFunction } from 'ajv';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const validators = new Map<string, ValidateFunction | null>();
parentPort?.on('message', ({ id, schema, value, compileOnly }: { id: number; schema: object | boolean; value: unknown; compileOnly: boolean }) => {
  let valid = false;
  try {
    const digest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    if (!validators.has(digest)) {
      if (validators.size >= 128) validators.delete(validators.keys().next().value!);
      try {
        const ajv = new Ajv({ allErrors: false, strict: true, strictRequired: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true });
        addFormats(ajv);
        const compiled: ValidateFunction | AsyncValidateFunction = ajv.compile(schema);
        validators.set(digest, '$async' in compiled ? null : compiled);
      } catch { validators.set(digest, null); }
    }
    const validate = validators.get(digest);
    valid = !!validate && (compileOnly || validate(value) === true);
  } catch { /* Return no schema text, arguments or provider details. */ }
  parentPort?.postMessage({ id, valid });
});
