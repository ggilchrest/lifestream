import { PwceGatewayClient, type PwceClientOptions } from './client.ts';
import { EXPECTED_PWCE_DISPATCH_BUNDLE } from './dispatch-bundle.ts';
import { PwceCallScope, PwceTransportError, boundedFetch, checkStatus, encodeRequest, readJsonObject, transportLimit } from './transport.ts';

export type PwceDispatchClientOptions = PwceClientOptions & { readonly dispatcherToken: string };
const bundle = EXPECTED_PWCE_DISPATCH_BUNDLE;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new PwceTransportError('invalid_request', 'PWCE trusted dispatch input cannot replace its bound scope, operation or credentials');
const incompatible = () => new PwceTransportError('incompatible_dispatch_contract', 'PWCE trusted dispatch contract is incompatible');

/** Transport only. The trusted host owns both credentials. This client never
 * manufactures canonical authority receipts or infers effect success. */
export class PwceTrustedDispatchClient {
  private readonly core: PwceGatewayClient;
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: PwceDispatchClientOptions) {
    this.core = new PwceGatewayClient(options);
    if (typeof options.dispatcherToken !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(options.dispatcherToken) || options.dispatcherToken === options.token) throw new PwceTransportError('invalid_configuration', 'PWCE dispatcher requires a distinct bounded host credential');
    this.baseUrl = new URL(options.baseUrl).href.replace(/\/$/, '');
    this.headers = Object.freeze({ Authorization: `Bearer ${options.token}`, 'X-PWCE-Dispatcher-Token': options.dispatcherToken, 'X-PWCE-Dispatch-Contract': bundle.bundleDigest, 'Content-Type': 'application/json' });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = transportLimit(options.requestTimeoutMs, 5000, 30_000);
  }
  private async json(path: string, scope: PwceCallScope, body?: string): Promise<Record<string, unknown>> {
    const response = await boundedFetch(this.fetchImpl, this.baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: this.headers, ...(body === undefined ? {} : { body }) }, scope);
    const result = await readJsonObject(response, scope); checkStatus(response, result); scope.check(); return result;
  }
  private async negotiateWithin(scope: PwceCallScope): Promise<void> {
    const [, received] = await Promise.all([this.core.negotiate(scope.signal), this.json('/gateway/v1/dispatch/bundle', scope)]);
    scope.check();
    if (Object.keys(received).sort().join(',') !== Object.keys(bundle).sort().join(',') ||
      ['bundleId','bundleVersion','dispatchProfileId','dispatchProfileVersion','digestAlgorithm','bundleDigest'].some(key => received[key] !== bundle[key as keyof typeof bundle]) ||
      !object(received.requiredGatewayBundle) || Object.keys(received.requiredGatewayBundle).length !== 3 ||
      Object.entries(bundle.requiredGatewayBundle).some(([key,value]) => (received.requiredGatewayBundle as Record<string,unknown>)[key] !== value) ||
      JSON.stringify(received.artifacts) !== JSON.stringify(bundle.artifacts)) throw incompatible();
  }
  async negotiate(signal?: AbortSignal): Promise<void> {
    const scope = new PwceCallScope(this.timeoutMs, signal);
    try { await this.negotiateWithin(scope); } finally { scope.close(); }
  }
  authorizeDispatch(authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('authority.authorizeDispatch', authorityContextRef, input, signal);
  }
  invoke(authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('capabilities.invoke', authorityContextRef, input, signal);
  }
  private async request(operation: 'authority.authorizeDispatch' | 'capabilities.invoke', authorityContextRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof authorityContextRef !== 'string' || !authorityContextRef || authorityContextRef.length > 128 || !object(input) ||
      ['operation','authorityContextRef','token','dispatcherToken','profileId','profileVersion','dispatchProfileId','dispatchProfileVersion'].some(key => Object.hasOwn(input,key))) throw invalid();
    // Freeze the wire bytes before the first await. No automatic retry or fallback.
    const request = { ...structuredClone(input), operation, authorityContextRef, profileId: 'pwce-agent-gateway.v1', profileVersion: '1.0.0', dispatchProfileId: bundle.dispatchProfileId, dispatchProfileVersion: bundle.dispatchProfileVersion };
    const encoded = encodeRequest(request), scope = new PwceCallScope(this.timeoutMs, signal);
    try {
      await this.negotiateWithin(scope);
      const response = await this.json('/gateway/v1/dispatch', scope, encoded);
      for (const key of ['profileId','profileVersion','dispatchProfileId','dispatchProfileVersion','requestId','correlationId','worldRef','executionEnvironmentRef'] as const) {
        if (response[key] !== request[key as keyof typeof request] || response[key] === undefined) throw new PwceTransportError('malformed_response', 'PWCE trusted dispatch response does not match the original request');
      }
      if (typeof response.status !== 'string' || !response.status || response.status.length > 64) throw new PwceTransportError('malformed_response', 'PWCE trusted dispatch response has no bounded disposition');
      return response;
    } finally { scope.close(); }
  }
}
