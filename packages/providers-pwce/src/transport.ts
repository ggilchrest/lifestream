/** Consumer transport limits under the unchanged published PWCE bundle. */
export const PWCE_MAX_TRANSPORT_BYTES = 1_048_576;

export class PwceTransportError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly source: "local" | "provider";
  constructor(code: string, message: string, status?: number, source: "local" | "provider" = "local") {
    super(message);
    this.name = "PwceTransportError";
    this.code = code;
    this.status = status;
    this.source = source;
  }
}

export function transportLimit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new PwceTransportError("invalid_configuration", "PWCE transport duration is outside its supported bounds");
  }
  return selected;
}

const cancelled = () => new PwceTransportError("cancelled", "PWCE request was cancelled");
export const deadlineExceeded = () => new PwceTransportError("deadline_exceeded", "PWCE request deadline exceeded");
const unavailable = () => new PwceTransportError("unavailable", "PWCE transport is unavailable");
const malformed = () => new PwceTransportError("malformed_response", "PWCE response is malformed or incomplete");
const limitExceeded = () => new PwceTransportError("limit_exceeded", "PWCE transport exceeds the 1 MiB limit");

/** A single budget spans negotiation and the operation. It never cancels its parent. */
export class PwceCallScope {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expiresAt: number;
  private readonly parent: AbortSignal | undefined;
  private readonly parentAbort = () => this.abort(cancelled());
  get signal(): AbortSignal { return this.controller.signal; }
  constructor(timeoutMs: number, parent?: AbortSignal) {
    this.parent = parent;
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.abort(deadlineExceeded()), timeoutMs);
    parent?.addEventListener("abort", this.parentAbort, { once: true });
    if (parent?.aborted) this.parentAbort();
  }
  abort(error: PwceTransportError): void { if (!this.signal.aborted) this.controller.abort(error); }
  check(): void {
    // Synchronous parsing can finish before the event loop services its timer.
    if (performance.now() >= this.expiresAt) this.abort(deadlineExceeded());
    if (this.signal.aborted) throw this.signal.reason;
  }
  async wait<T>(operation: Promise<T>): Promise<T> {
    // Even a custom transport that ignores AbortSignal cannot extend the budget.
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
    try {
      const value = await Promise.race([operation, aborted]);
      this.check();
      return value;
    } catch (error) {
      this.check();
      // Raw fetch/stream errors can contain credentials or request URLs.
      throw error instanceof PwceTransportError ? error : unavailable();
    } finally { this.signal.removeEventListener("abort", onAbort); }
  }
  close(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.parentAbort);
    this.abort(cancelled());
  }
}

export function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  // Cancellation must not stall completion if an underlying source misbehaves.
  if (body && !body.locked) void body.cancel().catch(() => undefined);
}

export async function boundedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, scope: PwceCallScope): Promise<Response> {
  scope.check();
  const pending = Promise.resolve().then(() => {
    scope.check();
    return fetchImpl(url, { ...init, redirect: "error", signal: scope.signal });
  }).then(response => {
    if (scope.signal.aborted) cancelBody(response.body);
    return response;
  });
  return scope.wait(pending);
}

export function encodeRequest(body: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(body); } catch { throw new PwceTransportError("invalid_request", "PWCE request must be JSON serializable"); }
  if (encoded === undefined) throw new PwceTransportError("invalid_request", "PWCE request must be JSON serializable");
  if (Buffer.byteLength(encoded, "utf8") > PWCE_MAX_TRANSPORT_BYTES) throw limitExceeded();
  return encoded;
}

function watchReader(reader: ReadableStreamDefaultReader<Uint8Array>, scope: PwceCallScope): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scope.signal.removeEventListener("abort", release);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  };
  scope.signal.addEventListener("abort", release, { once: true });
  if (scope.signal.aborted) release();
  return release;
}

export async function readJsonObject(response: Response, scope: PwceCallScope): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > PWCE_MAX_TRANSPORT_BYTES) {
    cancelBody(response.body);
    throw limitExceeded();
  }
  if (!response.body) throw malformed();
  const reader = response.body.getReader();
  const release = watchReader(reader, scope);
  let bytes = new Uint8Array(4096);
  let size = 0;
  try {
    while (true) {
      const chunk = await scope.wait(reader.read());
      if (chunk.done) break;
      const needed = size + chunk.value.byteLength;
      if (needed > PWCE_MAX_TRANSPORT_BYTES) throw limitExceeded();
      if (needed > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(PWCE_MAX_TRANSPORT_BYTES, Math.max(needed, bytes.byteLength * 2)));
        expanded.set(bytes.subarray(0, size));
        bytes = expanded;
      }
      bytes.set(chunk.value, size);
      size = needed;
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw malformed(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
    scope.check();
    return value as Record<string, unknown>;
  } finally { release(); }
}

export function checkStatus(response: Response, value: Record<string, unknown>): void {
  if (response.ok) return;
  const error = value.error;
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof rawCode === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(rawCode) ? rawCode : "http_error";
  // Preserve the producer's machine-readable denial, not arbitrary echoed prose.
  throw new PwceTransportError(code, `PWCE gateway rejected the request (${code})`, response.status, "provider");
}

export type PwceInvalidationEvent = { readonly id: string | null; readonly event: string; readonly data: string };

export async function* readEventStream(response: Response, scope: PwceCallScope): AsyncGenerator<PwceInvalidationEvent> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
    cancelBody(response.body);
    throw malformed();
  }
  const reader = response.body.getReader();
  const release = watchReader(reader, scope);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let frameBytes = 0;
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];
  try {
    while (true) {
      const chunk = await scope.wait(reader.read());
      if (chunk.done) {
        // An incomplete frame cannot silently lose an invalidation or become a
        // success-shaped event. Only blank-line-terminated frames are delivered.
        if (frameBytes) throw malformed();
        return;
      }
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        scope.check();
        // Work on bounded slices even if a transport hands us one giant chunk.
        const slice = chunk.value.subarray(offset, Math.min(offset + 16_384, chunk.value.byteLength));
        const newline = slice.indexOf(10);
        const count = newline < 0 ? slice.byteLength : newline + 1;
        frameBytes += count;
        if (frameBytes > PWCE_MAX_TRANSPORT_BYTES) throw limitExceeded();
        try { line += decoder.decode(slice.subarray(0, count), { stream: true }); }
        catch { throw malformed(); }
        offset += count;
        if (newline < 0) continue;
        const rawLine = line.slice(0, -1);
        const current = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        line = "";
        if (!current) {
          const parsed = data.length ? { id, event, data: data.join("\n") } : null;
          frameBytes = 0;
          id = null;
          event = "message";
          data = [];
          if (parsed) { scope.check(); yield parsed; }
        } else if (!current.startsWith(":")) {
          const separator = current.indexOf(":");
          const field = separator < 0 ? current : current.slice(0, separator);
          const value = separator < 0 ? "" : current.slice(separator + 1).replace(/^ /, "");
          if (field === "id" && !value.includes("\0")) id = value;
          else if (field === "event") event = value || "message";
          else if (field === "data") data.push(value);
        }
      }
    }
  } finally { release(); }
}
