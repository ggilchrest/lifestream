import { boundedFetch, cancelBody, checkStatus, deadlineExceeded, encodeRequest, PwceCallScope, readEventStream, readJsonObject, transportLimit } from "./transport.ts";
import type { PwceInvalidationEvent } from "./transport.ts";
export type { PwceInvalidationEvent } from "./transport.ts";
export type PwceProfile = { readonly profileId: string; readonly profileVersion: string; readonly bundleId: string; readonly bundleVersion: string; readonly schemaStatus: string; readonly schemaDigest: string; readonly operationCatalogVersion: string; readonly operationCatalogDigest: string; readonly compatibilityRange?: { readonly minimum: string; readonly maximum: string }; readonly operationCatalog: readonly { readonly operation: string; readonly kind?: string; readonly availability?: string }[] };
export type PwceBundle = { readonly bundleId: string; readonly bundleVersion: string; readonly bundleDigest: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[]; readonly generatedClient: { readonly path: string; readonly sha256: string } };
export type PwceClientOptions = { readonly baseUrl: string; readonly token: string; readonly fetchImpl?: typeof fetch; readonly requestTimeoutMs?: number; readonly streamLifetimeMs?: number };
export type PwceClientResult = { readonly status: string; readonly [key: string]: unknown };
const CORE_OPERATIONS = Object.freeze(["context.getPreparedInputs", "context.query", "evidence.get", "events.subscribe", "authority.evaluate", "authority.authorizeDispatch", "authority.getGrants", "capabilities.getSnapshot", "capabilities.invoke", "capabilities.getInvocation", "trace.publish", "health.get"]);
const objectInput=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export const EXPECTED_PWCE_PROFILE = Object.freeze({ profileId: "pwce-agent-gateway.v1", profileVersion: "1.0.0", bundleId: "pwce-agent-gateway.bundle.v1", bundleVersion: "1.0.0", schemaDigest: "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2", operationCatalogVersion: "0.1.0", operationCatalogDigest: "445cb4e4b9811a26a41c5821c7d68b09f377b69d24d42ec6dcd0acec5d950b65" });
export const EXPECTED_PWCE_ARTIFACTS = Object.freeze([
  { path: "contracts/gateway/operation-catalog.json", sha256: "51bfb941913fc27578dc3c4b3ca038d4bfdf4433eda72f2069173503e7b19a0c" },
  { path: "contracts/gateway/pwce-agent-gateway-profile.schema.json", sha256: "268a4e670ba9b32457725944c87ec46fda7dda821dc2f48fc5d8ff022f434e36" },
  { path: "contracts/gateway/pwce-agent-gateway-request.schema.json", sha256: "56fdd84719ddbe6d5d2a9644e9079b25df2e719dcbf0a9e33b3bf16d79760175" },
  { path: "contracts/gateway/pwce-agent-gateway-response.schema.json", sha256: "06fc6a9635c192329d43723f596330a336f1f3e57edd05e7d634110ebbb6f9ae" },
  { path: "contracts/gateway/pwce-lifestream-compatibility-lock.schema.json", sha256: "25fe08baaf362deb929abdb99980a7911fc6b63a4cbaf651749d66b021ffd78e" },
  { path: "contracts/gateway/pwce-agent-gateway-authority-request.schema.json", sha256: "c88e5eb7bb98c867ed5e0a2bf71c4e58f012aa068ecd8fc93cd40caecc42b318" },
  { path: "contracts/gateway/pwce-agent-gateway-authority-response.schema.json", sha256: "b064fc855886a63beb7ca934cdef8f2c51a20e9244c399a0d19afeb635a2c82f" },
] as const);
export const EXPECTED_PWCE_GENERATED_CLIENT_SHA256 = "fdb2a5a425b1a54e0d41c923e6ae701eb865e710334869c885b499f06abde175";

export class PwceGatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly streamLifetimeMs: number;
  constructor(options: PwceClientOptions) {
    if (!options.baseUrl || !options.token) throw new Error("PWCE gateway URL and token are required");
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new Error("PWCE gateway URL is invalid"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("PWCE gateway URL is invalid");
    this.baseUrl = url.href.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = transportLimit(options.requestTimeoutMs, 5000, 30_000);
    this.streamLifetimeMs = transportLimit(options.streamLifetimeMs, 35_000, 60_000);
  }
  private async call<T>(signal: AbortSignal | undefined, operation: (scope: PwceCallScope) => Promise<T>): Promise<T> {
    const scope = new PwceCallScope(this.requestTimeoutMs, signal);
    try { scope.check(); return await operation(scope); } finally { scope.close(); }
  }
  profile(signal?: AbortSignal): Promise<PwceProfile> { return this.call(signal, scope => this.readProfile(scope)); }
  private async readProfile(scope: PwceCallScope): Promise<PwceProfile> { const profile = await this.json<PwceProfile>("/gateway/v1/profile", scope); if (profile.profileId !== EXPECTED_PWCE_PROFILE.profileId || profile.profileVersion !== EXPECTED_PWCE_PROFILE.profileVersion || profile.bundleId !== EXPECTED_PWCE_PROFILE.bundleId || profile.bundleVersion !== EXPECTED_PWCE_PROFILE.bundleVersion || profile.schemaDigest !== EXPECTED_PWCE_PROFILE.schemaDigest || profile.operationCatalogVersion !== EXPECTED_PWCE_PROFILE.operationCatalogVersion || profile.operationCatalogDigest !== EXPECTED_PWCE_PROFILE.operationCatalogDigest || profile.schemaStatus !== "published") throw new Error("PWCE gateway profile is incompatible");
    if (!Array.isArray(profile.operationCatalog) || profile.operationCatalog.length !== CORE_OPERATIONS.length
      || new Set(profile.operationCatalog.map(entry=>entry?.operation)).size !== CORE_OPERATIONS.length
      || CORE_OPERATIONS.some(operation=>!profile.operationCatalog.some(entry=>entry?.operation===operation)))
      throw new Error("PWCE gateway required core operation catalog is incompatible");
    return profile; }
  bundle(signal?: AbortSignal): Promise<PwceBundle> { return this.call(signal, scope => this.readBundle(scope)); }
  private async readBundle(scope: PwceCallScope): Promise<PwceBundle> { const bundle = await this.json<PwceBundle>("/gateway/v1/bundle", scope); if (bundle.bundleId !== EXPECTED_PWCE_PROFILE.bundleId || bundle.bundleVersion !== EXPECTED_PWCE_PROFILE.bundleVersion || bundle.bundleDigest !== EXPECTED_PWCE_PROFILE.schemaDigest || bundle.generatedClient?.path !== "src/gateway/generated-client.js" || bundle.generatedClient?.sha256 !== EXPECTED_PWCE_GENERATED_CLIENT_SHA256 || JSON.stringify(bundle.artifacts) !== JSON.stringify(EXPECTED_PWCE_ARTIFACTS)) throw new Error("PWCE gateway bundle is incompatible"); return bundle; }
  negotiate(signal?: AbortSignal): Promise<{ readonly profile: PwceProfile; readonly bundle: PwceBundle }> { return this.call(signal, scope => this.readNegotiation(scope)); }
  private async readNegotiation(scope: PwceCallScope): Promise<{ readonly profile: PwceProfile; readonly bundle: PwceBundle }> {
    const [profile, bundle] = await Promise.all([this.readProfile(scope), this.readBundle(scope)]);
    scope.check();
    return { profile, bundle };
  }
  async authority(siteRefs: readonly string[], signal?: AbortSignal): Promise<PwceClientResult> {
    const body = encodeRequest({ siteRefs: [...siteRefs] });
    return this.call(signal, async scope => {
      await this.readNegotiation(scope);
      return this.json("/gateway/v1/authority", scope, { method: "POST", body });
    });
  }
  async request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<PwceClientResult> {
    if(!objectInput(payload)||Object.hasOwn(payload,'token'))throw new Error('PWCE request body cannot supply transport credentials');
    // Snapshot before asynchronous negotiation; later caller mutation cannot change
    // the operation, authority or normalized input that was admitted here.
    const body=structuredClone(payload);
    if(typeof body.operation!=='string'||!CORE_OPERATIONS.includes(body.operation))throw new Error('PWCE operation is not advertised');
    const encoded = encodeRequest(body);
    return this.call(signal, async scope => {
      await this.readNegotiation(scope);
      return this.json("/gateway/v1/request", scope, { method: "POST", body: encoded });
    });
  }
  private async boundRequest(operation:string,authorityContextRef:string,input:Record<string,unknown>,signal?:AbortSignal):Promise<PwceClientResult> {
    if(typeof authorityContextRef!=='string'||!authorityContextRef.trim())throw new Error('PWCE authority reference is required');
    if(!objectInput(input)||['operation','authorityContextRef','token'].some(field=>Object.hasOwn(input,field)))throw new Error('PWCE input cannot replace a bound operation, authority or transport credential');
    return this.request({...structuredClone(input),operation,authorityContextRef},signal);
  }
  getPreparedInputs(authorityContextRef: string, siteRef: string, signal?: AbortSignal): Promise<PwceClientResult> { return this.request({ operation: "context.getPreparedInputs", authorityContextRef, siteRef }, signal); }
  queryContext(authorityContextRef: string, query: Record<string, unknown>, signal?: AbortSignal): Promise<PwceClientResult> { return this.boundRequest("context.query", authorityContextRef, query, signal); }
  getEvidence(authorityContextRef: string, evidenceRef: string, signal?: AbortSignal): Promise<PwceClientResult> { return this.request({ operation: "evidence.get", authorityContextRef, evidenceRef }, signal); }
  getGrants(authorityContextRef: string, signal?: AbortSignal): Promise<PwceClientResult> { return this.request({ operation: "authority.getGrants", authorityContextRef }, signal); }
  evaluate(authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PwceClientResult> { return this.boundRequest("authority.evaluate", authorityContextRef, input, signal); }
  authorizeDispatch(authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PwceClientResult> { return this.boundRequest("authority.authorizeDispatch", authorityContextRef, input, signal); }
  getCapabilities(authorityContextRef: string, signal?: AbortSignal): Promise<PwceClientResult> { return this.request({ operation: "capabilities.getSnapshot", authorityContextRef }, signal); }
  invoke(authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PwceClientResult> { return this.boundRequest("capabilities.invoke", authorityContextRef, input, signal); }
  getInvocation(authorityContextRef: string, actionRef: string, signal?: AbortSignal): Promise<PwceClientResult> { return this.request({ operation: "capabilities.getInvocation", authorityContextRef, actionRef }, signal); }
  publishTrace(authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PwceClientResult> { return this.boundRequest("trace.publish", authorityContextRef, input, signal); }
  eventsUrl(authorityContextRef: string, siteRef: string, afterCursor = "0", limit = 100): string { const params = new URLSearchParams({ authorityContextRef, siteRef, afterCursor, limit: String(limit) }); return `${this.baseUrl}/gateway/v1/events?${params}`; }
  async *subscribeInvalidations(authorityContextRef: string, siteRef: string, options: { readonly afterCursor?: string; readonly limit?: number; readonly signal?: AbortSignal } = {}): AsyncGenerator<PwceInvalidationEvent> {
    const url = this.eventsUrl(authorityContextRef, siteRef, options.afterCursor ?? "0", options.limit ?? 100);
    const scope = new PwceCallScope(this.streamLifetimeMs, options.signal);
    const headersExpiresAt = performance.now() + this.requestTimeoutMs;
    const checkHeadersDeadline = () => {
      if (performance.now() >= headersExpiresAt) scope.abort(deadlineExceeded());
      scope.check();
    };
    const headersDeadline = setTimeout(() => scope.abort(deadlineExceeded()), this.requestTimeoutMs);
    try {
      scope.check();
      await this.readNegotiation(scope);
      checkHeadersDeadline();
      const response = await boundedFetch(this.fetchImpl, url, {
        method: "GET", headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
      }, scope);
      try {
        if (!response.ok) checkStatus(response, await readJsonObject(response, scope));
        checkHeadersDeadline();
        clearTimeout(headersDeadline);
        yield* readEventStream(response, scope);
      } finally { cancelBody(response.body); }
    } finally { clearTimeout(headersDeadline); scope.close(); }
  }
  health(authorityContextRef: string, signal?: AbortSignal): Promise<PwceClientResult> { return this.request({ operation: "health.get", authorityContextRef }, signal); }
  private async json<T extends object>(path: string, scope: PwceCallScope, options: { readonly method?: string; readonly body?: string } = {}): Promise<T> {
    const response = await boundedFetch(this.fetchImpl, `${this.baseUrl}${path}`, {
      method: options.method ?? "GET", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(options.body === undefined ? {} : { body: options.body }),
    }, scope);
    const value = await readJsonObject(response, scope);
    checkStatus(response, value);
    return value as T;
  }
}
