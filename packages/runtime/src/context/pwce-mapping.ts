export type PwceKnowledgeState = "current" | "stale" | "unknown" | "conflicted" | "unavailable" | "notDetected";
export type PwceContextMode = "prepared" | "current" | "history" | "asOf" | "explain" | "search";
export type PwceExecutionMode = "normal" | "live" | "test" | "replay" | "simulation" | "dry-run";
export type PwceContradiction = { readonly evidenceRef: string; readonly sourceRef: string; readonly eventTime: string; readonly value?: unknown };
export type PwceWorldItem = {
  readonly itemRef: string; readonly property: string; readonly value?: unknown;
  readonly knowledgeState: PwceKnowledgeState; readonly basis: "observed" | "derived" | null;
  readonly sourceRevision: string; readonly evidenceRefs: readonly string[]; readonly limitations: readonly string[];
  readonly subjectRef?: string; readonly siteRef?: string; readonly sourceRef?: string;
  readonly eventTime?: string; readonly recordedAt?: string; readonly freshnessMs?: number | null;
  readonly freshnessState?: "current" | "stale" | "unknown"; readonly freshnessAccepted?: boolean;
  readonly ageMs?: number; readonly quality?: string; readonly unit?: string; readonly confidence?: number;
  readonly projectionRevision?: string; readonly sourceRevisionKind?: "producerRevision" | "evidenceIntegrity";
  readonly validUntil?: string; readonly reason?: string; readonly contradictions?: readonly PwceContradiction[];
};
export type LifestreamWorldContextSlice = {
  readonly profileId: "lifestream-pwce.v1"; readonly worldRef: string; readonly environmentRef: string;
  readonly siteRefs: readonly string[]; readonly authorityContextRef: string; readonly sourceRevision: string;
  readonly asOf: string; readonly items: readonly PwceWorldItem[]; readonly limitations: readonly string[];
};
export type PwceResponseBinding = {
  readonly worldRef: string; readonly executionEnvironmentRef: PwceExecutionMode;
  readonly siteRefs: readonly string[]; readonly authorityContextRef: string; readonly authorityExpiresAt: string;
  readonly requestId: string; readonly correlationId: string;
  readonly maxItems?: number; readonly maxBytes?: number; readonly now?: number;
};
export type PwceContextMappingRequest = PwceResponseBinding & {
  readonly mode: PwceContextMode; readonly subjectRef?: string; readonly subjectsBySite?: Readonly<Record<string, string>>; readonly property?: string; readonly asOf?: string;
};
export type PwceQualifiedSlice = LifestreamWorldContextSlice & {
  readonly queryMode: PwceContextMode; readonly evaluatedAt: string; readonly receivedAt: string;
  readonly authorityExpiresAt: string; readonly requestId: string; readonly correlationId: string;
  readonly sliceRef?: string; readonly invalidationCursor: string; readonly knowledgeState: string;
  readonly history: readonly PwceWorldItem[];
  readonly matches: readonly { readonly subjectRef: string; readonly siteRef: string; readonly displayName?: string }[];
  readonly sources: readonly { readonly sourceRef: string; readonly status: string; readonly lastStatusReason?: string | null; readonly lastEventTime?: string | null }[];
  readonly hasMore: boolean; readonly nextCursor: string | null;
};

export class PwceMappingError extends Error {
  readonly code: "invalid_response" | "scope_mismatch" | "limit_exceeded" | "authority_expired";
  constructor(code: PwceMappingError["code"]) {
    super(`PWCE context mapping failed (${code})`); this.name = "PwceMappingError"; this.code = code;
  }
}
function fail(code: PwceMappingError["code"] = "invalid_response"): never { throw new PwceMappingError(code); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown, maximum = 512): string => typeof value === "string" && value.length > 0 && value.length <= maximum ? value : fail();
const strings = (value: unknown, maximum = 128): string[] => list(value, maximum).map(item => text(item, 2048));
const list = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value)) return fail();
  if (value.length > maximum) return fail("limit_exceeded");
  return value;
};
const stamp = (value: unknown): string => {
  const source = text(value, 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(source) || !Number.isFinite(Date.parse(source))) return fail();
  const [year, month, day] = source.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0); calendar.setUTCFullYear(year!, month! - 1, day!);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return fail();
  return source;
};
const revision = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : text(value);
const same = (actual: unknown, expected: string): void => { if (actual !== expected) fail("scope_mismatch"); };
const optionalText = (value: unknown): string | undefined => value === undefined ? undefined : text(value);
const modeValues = ["prepared", "current", "history", "asOf", "explain", "search"];
const executionModes = ["normal", "live", "test", "replay", "simulation", "dry-run"];
const states = ["current", "stale", "unknown", "conflicted", "unavailable", "notDetected"];

/** Existing typed projection helper, retained for callers of the original profile. */
export function mapPwceSlice(input: Omit<LifestreamWorldContextSlice, "profileId" | "items"> & { items: readonly PwceWorldItem[] }): LifestreamWorldContextSlice {
  if (!input.worldRef || !input.environmentRef || !input.authorityContextRef || !input.sourceRevision) throw new Error("incomplete PWCE context binding");
  return { ...structuredClone(input), profileId: "lifestream-pwce.v1" };
}

function envelope(value: unknown, binding: PwceResponseBinding) {
  const now = binding.now ?? Date.now();
  if (!Number.isFinite(now) || Date.parse(stamp(binding.authorityExpiresAt)) <= now) fail("authority_expired");
  text(binding.authorityContextRef, 128); text(binding.worldRef, 128);
  text(binding.requestId, 128); text(binding.correlationId, 128);
  if (!executionModes.includes(binding.executionEnvironmentRef)) fail("scope_mismatch");
  const sites = strings(binding.siteRefs, 32);
  if (!sites.length || new Set(sites).size !== sites.length) fail("scope_mismatch");
  const maxItems = binding.maxItems ?? 50, maxBytes = binding.maxBytes ?? 262_144;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100 || !Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 262_144) fail("limit_exceeded");
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { return fail(); }
  if (encoded === undefined) return fail();
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) fail("limit_exceeded");
  // Own the read projection: subsequent input mutation cannot rewrite evidence.
  const response = object(JSON.parse(encoded));
  same(response.profileId, "pwce-agent-gateway.v1"); same(response.profileVersion, "1.0.0");
  same(response.worldRef, binding.worldRef); same(response.executionEnvironmentRef, binding.executionEnvironmentRef);
  same(response.requestId, binding.requestId); same(response.correlationId, binding.correlationId);
  // The current producer binds authority at request admission, not by echoing it.
  // If a later response does echo authority, it may not contradict that request.
  if (response.authorityContextRef !== undefined) same(response.authorityContextRef, binding.authorityContextRef);
  return { response, sites, maxItems, now };
}

function site(value: unknown, sites: readonly string[]): string {
  const result = text(value);
  if (!sites.includes(result)) fail("scope_mismatch");
  return result;
}
function rootSites(response: Record<string, unknown>, sites: readonly string[]): void {
  const actual = response.siteRefs === undefined ? [text(response.siteRef)] : strings(response.siteRefs, 32);
  if (actual.length !== sites.length || new Set(actual).size !== actual.length || actual.some(value => !sites.includes(value))) fail("scope_mismatch");
  if (response.siteRef !== undefined && (actual.length !== 1 || response.siteRef !== actual[0])) fail("scope_mismatch");
}
function projections(input: Record<string, unknown>, sites: readonly string[], sourceRevision: string, expected: PwceContextMappingRequest, historical = false): PwceWorldItem {
  const subjectRef = text(input.entityRef), property = text(input.property);
  const siteRef = site(input.siteRef, sites);
  const expectedSubject = expected.subjectsBySite?.[siteRef] ?? expected.subjectRef;
  if (expectedSubject !== undefined) same(subjectRef, expectedSubject);
  if (expected.property !== undefined) same(property, expected.property);
  const knowledgeState = historical ? "unknown" : text(input.knowledgeState) as PwceKnowledgeState;
  if (!states.includes(knowledgeState)) fail();
  const basis = historical ? "observed" : input.basis === undefined && ["unknown", "unavailable", "notDetected"].includes(knowledgeState) ? null : input.basis;
  if (basis !== null && basis !== "observed" && basis !== "derived") fail();
  const evidenceRefs = historical ? [text(input.observationRef)] : strings(input.evidenceRefs ?? []);
  if (knowledgeState === "current" && (!Object.hasOwn(input, "value") || basis === null || !evidenceRefs.length)) fail();
  const item: PwceWorldItem = {
    itemRef: historical ? text(input.observationRef) : subjectRef, subjectRef, siteRef, property,
    ...(Object.hasOwn(input, "value") ? { value: input.value } : {}), knowledgeState, basis, sourceRevision, evidenceRefs,
    limitations: [...strings(input.limitations ?? []), ...(historical ? ["Historical observation; this is not a current world-state claim."] : [])],
  };
  for (const optional of ["mediaRefs", "watchRefs"]) if (input[optional] !== undefined && list(input[optional], 100).length) fail();
  const result = item as { -readonly [K in keyof PwceWorldItem]: PwceWorldItem[K] };
  result.sourceRevisionKind = "producerRevision";
  if (input.revision !== undefined) result.projectionRevision = revision(input.revision);
  for (const field of ["sourceRef", "quality", "unit", "reason"] as const) if (input[field] !== undefined) result[field] = text(input[field]);
  for (const field of ["eventTime", "recordedAt", "validUntil"] as const) if (input[field] !== undefined) result[field] = stamp(input[field]);
  for (const field of ["freshnessMs", "ageMs", "confidence"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (field === "freshnessMs" && value === null) { result.freshnessMs = null; continue; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field === "confidence" && value > 1)) fail();
    result[field] = value;
  }
  if (input.freshnessState !== undefined) {
    if (!["current", "stale", "unknown"].includes(String(input.freshnessState))) fail();
    result.freshnessState = input.freshnessState as "current" | "stale" | "unknown";
  }
  if (input.freshnessAccepted !== undefined) {
    if (typeof input.freshnessAccepted !== "boolean") fail();
    result.freshnessAccepted = input.freshnessAccepted;
  }
  result.contradictions = list(input.contradictions ?? [], 100).map(candidate => {
    const entry = object(candidate), evidenceRef = text(entry.observationRef);
    if (!evidenceRefs.includes(evidenceRef)) fail();
    return { evidenceRef, sourceRef: text(entry.sourceRef), eventTime: stamp(entry.eventTime), ...(Object.hasOwn(entry, "value") ? { value: entry.value } : {}) };
  });
  if (knowledgeState === "conflicted" && result.contradictions.length < 2) fail();
  return result;
}

function boundedResult<T>(value: T, binding: PwceResponseBinding): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > (binding.maxBytes ?? 262_144)) fail("limit_exceeded");
  if (Date.parse(binding.authorityExpiresAt) <= (binding.now ?? Date.now())) fail("authority_expired");
  return value;
}

/** Map authenticated Gateway read results, never a canonical PWCE record store. */
export function mapPwceContextResponse(value: unknown, request: PwceContextMappingRequest): PwceQualifiedSlice {
  const { response, sites, maxItems, now } = envelope(value, request);
  if (!modeValues.includes(request.mode)) fail();
  for (const optional of ["mediaRefs", "watchRefs"]) if (response[optional] !== undefined && list(response[optional], 100).length) fail();
  rootSites(response, sites);
  if (!["prepared", "search"].includes(request.mode)) {
    same(response.property, text(request.property));
    if (sites.length === 1) same(response.entityRef, text(request.subjectsBySite?.[sites[0]!] ?? request.subjectRef));
    else {
      const subjects = object(request.subjectsBySite);
      if (Object.keys(subjects).length !== sites.length || Object.keys(subjects).some(key => !sites.includes(key))) fail("scope_mismatch");
      for (const requestedSite of sites) text(subjects[requestedSite]);
    }
  }
  const sourceRevision = revision(response.sourceRevision ?? response.revision);
  if (request.mode === "prepared" && response.revision !== undefined && revision(response.revision) !== sourceRevision) fail();
  const evaluatedAt = stamp(response.evaluatedAt);
  const asOf = request.mode === "asOf" ? stamp(response.asOf) : evaluatedAt;
  if (request.mode === "asOf" && Date.parse(asOf) !== Date.parse(stamp(request.asOf))) fail("scope_mismatch");
  const knowledgeState = text(response.knowledgeState);
  if (![...states, "known"].includes(knowledgeState)) fail();
  const invalidationCursor = text(response.invalidationCursor, 128);
  if (!/^\d+$/.test(invalidationCursor)) fail();
  if (response.hasMore !== undefined && typeof response.hasMore !== "boolean") fail();
  const hasMore = response.hasMore === true;
  const nextCursor = response.nextCursor == null ? null : text(response.nextCursor, 512);
  if (hasMore && ["history", "asOf"].includes(request.mode) && nextCursor === null) fail();
  const inherited = { siteRef: sites.length === 1 ? sites[0] : undefined, entityRef: response.entityRef, property: response.property };
  const map = (raw: unknown, historical = false) => projections({ ...inherited, ...object(raw) }, sites, sourceRevision, request, historical);
  let items: PwceWorldItem[] = [], history: PwceWorldItem[] = [];
  const matches: { subjectRef: string; siteRef: string; displayName?: string }[] = [];
  const sources: { sourceRef: string; status: string; lastStatusReason?: string | null; lastEventTime?: string | null }[] = [];
  if (request.mode === "prepared") {
    items = list(response.inputs, maxItems).map(item => map(item));
    for (const raw of list(response.sources, 100)) {
      const entry = object(raw);
      const source = { sourceRef: text(entry.sourceRef), status: text(entry.status) } as (typeof sources)[number];
      if (entry.siteRef !== undefined) site(entry.siteRef, sites);
      if (entry.lastStatusReason !== undefined) source.lastStatusReason = entry.lastStatusReason === null ? null : text(entry.lastStatusReason, 2048);
      if (entry.lastEventTime !== undefined) source.lastEventTime = entry.lastEventTime === null ? null : stamp(entry.lastEventTime);
      sources.push(source);
    }
  } else if (request.mode === "search") {
    for (const raw of list(response.matches, maxItems)) {
      const entry = object(raw), displayName = optionalText(entry.displayName);
      matches.push({ subjectRef: text(entry.entityRef), siteRef: site(entry.siteRef, sites), ...(displayName === undefined ? {} : { displayName }) });
    }
  } else if (request.mode === "history" || request.mode === "asOf") {
    history = list(response.observations, maxItems).map(item => map(item, true));
    if (request.mode === "asOf") {
      if (response.selected !== undefined) {
        if (["unknown", "conflicted", "unavailable", "notDetected"].includes(knowledgeState)) fail();
        const selected = object(response.selected);
        if (response.eventTime !== undefined) same(selected.eventTime, stamp(response.eventTime));
        const evidenceRefs = strings(response.evidenceRefs);
        if (!evidenceRefs.includes(text(selected.observationRef))) fail();
        items = [map({ ...response, ...selected, evidenceRefs })];
      } else if (knowledgeState === "conflicted") items = [map(response)];
      else if (knowledgeState !== "unknown" && knowledgeState !== "unavailable" && knowledgeState !== "notDetected") fail();
    }
  } else items = response.items === undefined ? [map(response)] : list(response.items, maxItems).map(item => map(item));
  return boundedResult({
    profileId: "lifestream-pwce.v1" as const, worldRef: request.worldRef, environmentRef: request.executionEnvironmentRef,
    siteRefs: [...sites], authorityContextRef: request.authorityContextRef, authorityExpiresAt: request.authorityExpiresAt,
    requestId: request.requestId, correlationId: request.correlationId, sourceRevision,
    queryMode: request.mode, evaluatedAt, receivedAt: new Date(now).toISOString(), asOf,
    ...(response.sliceRef === undefined ? {} : { sliceRef: text(response.sliceRef) }),
    invalidationCursor, knowledgeState, items, history, matches, sources, hasMore, nextCursor,
    limitations: strings(response.limitations ?? []),
  }, request);
}

export type PwceMappedEvidence = {
  readonly status: "known" | "unknown"; readonly worldRef: string; readonly environmentRef: string;
  readonly authorityContextRef: string; readonly authorityExpiresAt: string; readonly requestId: string; readonly correlationId: string;
  readonly evidenceRef: string; readonly limitations: readonly string[]; readonly item?: PwceWorldItem;
  readonly integrity?: Readonly<Record<string, string>>; readonly integrityStatus?: "producerReported";
  readonly transformationRefs?: readonly string[]; readonly dataClassification?: string; readonly reason?: string;
  readonly observationWorldId?: string;
  readonly observationEnvironment?: Readonly<Record<string, string>>;
  readonly provenance?: Readonly<Record<string, string | readonly string[]>>;
};
/** Evidence lookup needs its own currently authorized request; a reference is not permission. */
export function mapPwceEvidenceResponse(value: unknown, request: PwceResponseBinding & { readonly evidenceRef: string }): PwceMappedEvidence {
  const { response, sites } = envelope(value, request);
  const evidenceRef = text(request.evidenceRef);
  if (response.status !== "known" && response.status !== "unknown") fail();
  const base: PwceMappedEvidence = { status: response.status, worldRef: request.worldRef, environmentRef: request.executionEnvironmentRef,
    authorityContextRef: request.authorityContextRef, authorityExpiresAt: request.authorityExpiresAt,
    requestId: request.requestId, correlationId: request.correlationId, evidenceRef, limitations: strings(response.limitations ?? []) };
  if (response.status === "unknown") { if (response.evidence !== undefined) fail(); return boundedResult({ ...base, ...(response.reason === undefined ? {} : { reason: text(response.reason) }) }, request); }
  const record = object(response.evidence), payload = object(record.payload), integrity = object(response.integrity);
  same(record.recordId, evidenceRef); same(record.recordKind, "observation");
  same(record.sourceId, text(response.sourceRef)); same(record.eventTime, stamp(response.eventTime)); same(record.recordedAt, stamp(response.recordedAt));
  const reportedIntegrity = Object.fromEntries(["schemeId", "schemeVersion", "covers", "value"].map(key => [key, text(integrity[key])]));
  const originalIntegrity = object(record.integrity);
  for (const [key, entry] of Object.entries(reportedIntegrity)) same(originalIntegrity[key], entry);
  const item = projections({ ...payload, observationRef: evidenceRef, sourceRef: response.sourceRef, eventTime: response.eventTime, recordedAt: response.recordedAt }, sites, reportedIntegrity.value!, { ...request, mode: "history" }, true);
  const metadata: { observationWorldId?: string; observationEnvironment?: Record<string, string>; provenance?: Record<string, string | string[]> } = {};
  if (record.worldId !== undefined) metadata.observationWorldId = text(record.worldId);
  if (record.environment !== undefined) {
    const environment = object(record.environment);
    metadata.observationEnvironment = Object.fromEntries(["environmentId", "environmentClass", "executionMode"].map(key => [key, text(environment[key])]));
  }
  const transformationRefs = strings(response.transformationRefs);
  if (record.provenance !== undefined) {
    const original = object(record.provenance), provenance: Record<string, string | string[]> = {};
    for (const key of ["producerId", "processId", "processVersion", "providerRef", "sourceRegistrationVersion", "configurationVersion"]) if (original[key] !== undefined) provenance[key] = text(original[key]);
    for (const key of ["inputRefs", "authorityRefs", "transformationRefs"]) if (original[key] !== undefined) provenance[key] = strings(original[key]);
    if (JSON.stringify(provenance.transformationRefs) !== JSON.stringify(transformationRefs)) fail();
    metadata.provenance = provenance;
  }
  const dataClassification = text(response.dataClassification);
  if (record.dataClassification !== undefined) same(record.dataClassification, dataClassification);
  return boundedResult({ ...base, ...metadata, item: { ...item, sourceRevisionKind: "evidenceIntegrity" as const }, integrity: reportedIntegrity, integrityStatus: "producerReported" as const, transformationRefs, dataClassification }, request);
}
