import { randomUUID } from "node:crypto";

export type IdGenerator = { generate(): string };

export class SystemIdGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}

export const isOpaqueUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
