import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidationError } from "./errors.js";

type ValidateFunction = ((value: unknown) => boolean) & { errors?: ErrorObject[] | null };
type AjvLike = { addSchema(schema: unknown): void; getSchema(id: string): ValidateFunction | undefined };
type AjvConstructor = new (options: { allErrors: boolean; strict: boolean }) => AjvLike;
type AddFormats = (ajv: AjvLike) => void;
const require = createRequire(import.meta.url);
const Ajv2020 = (require("ajv/dist/2020").default ?? require("ajv/dist/2020")) as AjvConstructor;
const addFormats = require("ajv-formats") as AddFormats;
const safeValidationErrors = (errors: readonly ValidationError[] | null | undefined) =>
  (errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }));

export type ValidationResult = { valid: boolean; errors: ValidationError[] };
export type ContractValidator = {
  validate(schemaId: string, value: unknown): ValidationResult;
  schemaIds(): string[];
};

const schemaDirectory = join(dirname(fileURLToPath(import.meta.url)), "schemas");
const loadSchemas = (): unknown[] => readdirSync(schemaDirectory)
  .filter((name) => name.endsWith(".schema.json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(schemaDirectory, name), "utf8")) as unknown);

const normalizeErrors = (errors: ErrorObject[] | null | undefined) => safeValidationErrors(
  (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "validation failed"
  }))
);

export const createContractValidator = (): ContractValidator => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schemas = loadSchemas();
  for (const schema of schemas) ajv.addSchema(schema);
  const validators = new Map<string, ValidateFunction>();
  for (const schema of schemas) {
    if (typeof schema === "object" && schema !== null && "$id" in schema && typeof schema.$id === "string") {
      const validator = ajv.getSchema(schema.$id);
      if (!validator) throw new Error(`schema failed to compile: ${schema.$id}`);
      validators.set(schema.$id, validator);
    }
  }
  return {
    validate(schemaId, value) {
      const validator = validators.get(schemaId);
      if (!validator) return { valid: false, errors: [{ instancePath: "", keyword: "schema", message: "unknown schema" }] };
      const valid = validator(value) as boolean;
      return { valid, errors: valid ? [] : normalizeErrors(validator.errors) };
    },
    schemaIds: () => [...validators.keys()].sort()
  };
};
