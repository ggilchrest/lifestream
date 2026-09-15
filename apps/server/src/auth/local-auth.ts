import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@lifestream/storage-sqlite";

export const AUTH_PARAMETERS = Object.freeze({ password: "scrypt:N=32768,r=8,p=3,keyLength=32,saltBytes=16", totp: "RFC6238:HMAC-SHA1,digits=6,period=30,window=1", recoveryCodeCount: 10, recoveryCodeBytes: 32, adminIdleMs: 1_800_000, maxPasswordBytes: 1024 });
export class AuthenticationError extends Error { readonly status: number; readonly code: string; constructor(status = 401, code = "authentication_required") { super(code.replaceAll("_", " ")); this.status = status; this.code = code; } }
export type LocalContext = { principalId: string; sessionId: string; expiresAt: string; origin: string; owner: boolean; authenticatedAt: number; tokenHash: string };
export type LocalAuthOptions = { stateDirectory: string; installerToken?: string; now?: () => number; afterSafetyWrite?: () => void };
type Account = { principal_id: string; username: string; owner: number; password_verifier: string; totp_secret: string | null; totp_last_step: number; epoch: number; disabled: number; created_at: number };
type CredentialSnapshot = { account: Account; recoveryHashes: string[] };
type Session = { principal_id: string; session_id: string; csrf_hash: string; origin: string; epoch: number; authenticated_at: number; admin_last_activity: number; revoked: number };
export type LocalSession = { token: string; csrfToken: string; principalId: string; sessionId: string; owner: boolean; adminExpiresAt: string };
export type ProposedOperation = { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body: Record<string, unknown>; expectedRevision: number | null };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const opaque = () => randomBytes(32).toString("base64url");
const normalizeUser = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value)) throw new AuthenticationError(422, "invalid_account"); return value.toLowerCase(); };
const validatePassword = (password: string) => { if (typeof password !== "string" || [...password].length < 12 || Buffer.byteLength(password) > AUTH_PARAMETERS.maxPasswordBytes) throw new AuthenticationError(422, "password_requires_12_to_1024_bytes"); };
function derive(password: string, salt: string): Promise<string> { return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result.toString("hex")))); }
async function verifier(password: string): Promise<string> { validatePassword(password); const salt = randomBytes(16).toString("hex"); return `${salt}:${await derive(password, salt)}`; }
async function verifyPassword(password: string, stored: string): Promise<boolean> { const [salt, expected] = stored.split(":"); if (!salt || !expected || Buffer.byteLength(password) > AUTH_PARAMETERS.maxPasswordBytes) return false; return equal(await derive(password, salt), expected); }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function encodeBase32(bytes: Buffer): string { let bits = 0, value = 0, result = ""; for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) result += alphabet[(value << (5 - bits)) & 31]; return result; }
function decodeBase32(secret: string): Buffer { let bits = 0, value = 0; const bytes: number[] = []; for (const char of secret.toUpperCase().replace(/=+$/, "")) { const digit = alphabet.indexOf(char); if (digit < 0) throw new AuthenticationError(422, "invalid_mfa_seed"); value = (value << 5) | digit; bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(bytes); }
/** Interoperable RFC 6238 primitive. Enrollment and replay policy live in LocalAuthentication. */
export function totpCode(secret: string, timestamp: number, digits = 6): string { const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000))); const bytes = createHmac("sha1", decodeBase32(secret)).update(counter).digest(); const offset = bytes[bytes.length - 1]! & 15; const binary = bytes.readUInt32BE(offset) & 0x7fffffff; return String(binary % (10 ** digits)).padStart(digits, "0"); }
function validStep(secret: string, code: string, now: number, previous: number): number | undefined { if (!/^\d{6}$/.test(code)) return undefined; const current = Math.floor(now / 30_000); for (const step of [current, current - 1, current + 1]) if (step >= 0 && step > previous && equal(totpCode(secret, step * 30_000), code)) return step; return undefined; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
export const operationDigest = (operation: ProposedOperation) => digest(canonical(operation));

/** Owner-local authentication. The safety directory is deliberately outside database backup/restore. */
export class LocalAuthentication {
  private readonly database: Database; private readonly options: LocalAuthOptions; private readonly key: Buffer; private readonly now: () => number;
  private busy = 0; private readonly pendingMfa = new Map<string, { secret: string; until: number; principalId: string }>();
  constructor(database: Database, options: LocalAuthOptions) {
    this.database = database; this.options = options; this.now = options.now ?? Date.now;
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    const keyPath = join(options.stateDirectory, "authentication-key");
    if (!existsSync(keyPath)) { if (this.accountCount()) throw new AuthenticationError(503, "authentication_safety_state_missing"); try { this.writeExclusive(keyPath, randomBytes(32)); } catch (error) { if (!existsSync(keyPath)) throw error; } }
    this.key = readFileSync(keyPath); if (this.key.length !== 32) throw new AuthenticationError(503, "authentication_safety_state_invalid");
    this.reconcileCredentials();
  }
  private writeExclusive(path: string, data: string | Buffer): void { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); } const dir = openSync(this.options.stateDirectory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  private reconcileCredentials(): void {
    const latest = new Map<string, CredentialSnapshot>();
    const enrollment = join(this.options.stateDirectory, "owner-enrolled");
    if (existsSync(enrollment)) { const saved = JSON.parse(readFileSync(enrollment,"utf8")) as {principalId:string; payload:string}; const snapshot=JSON.parse(this.unseal(saved.payload,saved.principalId)) as CredentialSnapshot; latest.set(saved.principalId,snapshot); }
    for (const file of readdirSync(this.options.stateDirectory)) {
      if (!/^security-[a-f0-9-]+-[0-9]+\.json$/.test(file)) continue;
      const principal = file.slice(9, 45); const snapshot = JSON.parse(this.unseal(readFileSync(join(this.options.stateDirectory, file), "utf8"), principal)) as CredentialSnapshot;
      if (snapshot.account.principal_id !== principal) throw new AuthenticationError(503, "authentication_safety_state_invalid");
      const previous = latest.get(principal); if (!previous || previous.account.epoch < snapshot.account.epoch) latest.set(principal, snapshot);
    }
    for (const snapshot of latest.values()) { const current = this.account(snapshot.account.principal_id); if (!current || current.epoch < snapshot.account.epoch) this.applyCredentials(snapshot); else if (current.epoch === snapshot.account.epoch && !this.safetyMatches(current)) this.writeEpoch(current.principal_id, current.epoch); }
  }
  private applyCredentials(snapshot: CredentialSnapshot): void {
    const a = snapshot.account;
    this.database.transaction(tx => { const current = this.account(a.principal_id); if (current && current.epoch > a.epoch) throw new AuthenticationError(409, "credential_revision_conflict");
      tx.run("INSERT INTO local_accounts (principal_id,username,owner,password_verifier,totp_secret,totp_last_step,epoch,disabled,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET password_verifier=excluded.password_verifier,totp_secret=excluded.totp_secret,totp_last_step=excluded.totp_last_step,epoch=excluded.epoch,disabled=excluded.disabled", a.principal_id,a.username,a.owner,a.password_verifier,a.totp_secret,a.totp_last_step,a.epoch,a.disabled,a.created_at);
      tx.run("UPDATE local_recovery_codes SET consumed=1 WHERE principal_id=?", a.principal_id);
      for (const hash of snapshot.recoveryHashes) tx.run("INSERT INTO local_recovery_codes VALUES (?,?,?,0) ON CONFLICT(code_hash) DO UPDATE SET epoch=excluded.epoch,consumed=excluded.consumed", hash,a.principal_id,a.epoch);
      tx.run("UPDATE local_sessions SET revoked=1 WHERE principal_id=?", a.principal_id);
    });
    this.writeEpoch(a.principal_id,a.epoch);
  }
  private changeCredentials(account: Account, recoveryHashes: string[]): void {
    const snapshot = { account, recoveryHashes };
    this.writeExclusive(join(this.options.stateDirectory, `security-${account.principal_id}-${account.epoch}.json`), this.seal(JSON.stringify(snapshot), account.principal_id));
    this.options.afterSafetyWrite?.();
    this.applyCredentials(snapshot);
  }
  private activeRecoveryHashes(principalId: string): string[] { return (this.database.connection.prepare("SELECT code_hash FROM local_recovery_codes WHERE principal_id=? AND consumed=0").all(principalId) as Array<{code_hash:string}>).map(row=>row.code_hash); }
  private writeEpoch(principalId: string, epoch: number): void { const path = join(this.options.stateDirectory, `epoch-${principalId}`); const temporary = `${path}-${randomUUID()}`; this.writeExclusive(temporary, String(epoch)); renameSync(temporary, path); const dir = openSync(this.options.stateDirectory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  private safetyMatches(account: Account): boolean { try { return readFileSync(join(this.options.stateDirectory, `epoch-${account.principal_id}`), "utf8") === String(account.epoch); } catch { return false; } }
  private accountCount(): number { return (this.database.connection.prepare("SELECT COUNT(*) AS n FROM local_accounts").get() as { n: number }).n; }
  private account(principalId: string): Account | undefined { return this.database.connection.prepare("SELECT * FROM local_accounts WHERE principal_id = ?").get(principalId) as Account | undefined; }
  private seal(secret: string, principalId: string): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(Buffer.from(principalId)); const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(value => value.toString("base64url")).join("."); }
  private unseal(value: string, principalId: string): string { const [iv, tag, data] = value.split(".").map(part => Buffer.from(part, "base64url")); if (!iv || !tag || !data) throw new AuthenticationError(); const decipher = createDecipheriv("aes-256-gcm", this.key, iv); decipher.setAAD(Buffer.from(principalId)); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"); }
  private event(principalId: string | null, action: string): void { this.database.connection.prepare("INSERT INTO local_auth_events (principal_id,action,occurred_at) VALUES (?,?,?)").run(principalId, action, this.now()); }
  private rate(bucket: string, limit = 5): void { const key = digest(bucket), now = this.now(); this.database.transaction(tx => { const row = tx.get<{ window_start: number; attempts: number }>("SELECT * FROM local_auth_attempts WHERE bucket = ?", key); if (row && now >= row.window_start && now - row.window_start < 900_000 && row.attempts >= limit) throw new AuthenticationError(429, "authentication_attempt_limit"); tx.run("INSERT INTO local_auth_attempts VALUES (?,?,?) ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts", key, row && now - row.window_start < 900_000 && now >= row.window_start ? row.window_start : now, row && now - row.window_start < 900_000 && now >= row.window_start ? row.attempts + 1 : 1); }); }
  private async bounded<T>(operation: () => Promise<T>): Promise<T> { if (this.busy >= 2) throw new AuthenticationError(429, "authentication_busy"); this.busy++; try { return await operation(); } finally { this.busy--; } }
  status(): { mode: string; setupRequired: boolean; parameters: typeof AUTH_PARAMETERS } { return { mode: "local-password", setupRequired: !this.accountCount() && !existsSync(join(this.options.stateDirectory, "owner-enrolled")), parameters: AUTH_PARAMETERS }; }
  async setup(username: string, password: string, installerToken: string, origin: string): Promise<{ session: LocalSession; recoveryCodes: string[] }> {
    if (!this.options.installerToken || !equal(digest(installerToken), digest(this.options.installerToken)) || !this.status().setupRequired) throw new AuthenticationError(403, "installer_enrollment_closed_or_denied");
    const normalized = normalizeUser(username), principalId = randomUUID(), encoded = await this.bounded(() => verifier(password));
    const codes = Array.from({ length: AUTH_PARAMETERS.recoveryCodeCount }, opaque);
    if (this.accountCount() || existsSync(join(this.options.stateDirectory, "owner-enrolled"))) throw new AuthenticationError(409, "owner_already_enrolled");
    // Persist the recoverable credential intent before closing the installer claim.
    const account: Account = { principal_id: principalId, username: normalized, owner: 1, password_verifier: encoded, totp_secret: null, totp_last_step: -1, epoch: 1, disabled: 0, created_at: this.now() };
    const recoveryHashes=codes.map(code=>digest(`${principalId}:${code}`));
    try { this.writeExclusive(join(this.options.stateDirectory,"owner-enrolled"),JSON.stringify({principalId,payload:this.seal(JSON.stringify({account,recoveryHashes}),principalId)})); } catch { throw new AuthenticationError(409,"owner_already_enrolled"); }
    this.changeCredentials(account, recoveryHashes);
    this.event(principalId, "owner_enrolled"); return { session: this.issue(this.account(principalId)!, origin), recoveryCodes: codes };
  }
  private issue(account: Account, origin: string): LocalSession { const token = opaque(), csrfToken = createHmac("sha256",this.key).update(`csrf:${digest(token)}`).digest("base64url"), sessionId = randomUUID(), now = this.now(); this.database.connection.prepare("INSERT INTO local_sessions VALUES (?,?,?,?,?,?,?,?,0)").run(digest(token), account.principal_id, sessionId, digest(csrfToken), origin, account.epoch, now, now); return { token, csrfToken, principalId: account.principal_id, sessionId, owner: !!account.owner, adminExpiresAt: new Date(now + AUTH_PARAMETERS.adminIdleMs).toISOString() }; }
  async signIn(username: string, password: string, code: string, origin: string, remote: string): Promise<LocalSession> {
    const normalized = normalizeUser(username); this.rate(`remote:${remote}`, 40); this.rate(`signin:${normalized}`);
    return this.bounded(async () => {
      const account = this.database.connection.prepare("SELECT * FROM local_accounts WHERE username = ?").get(normalized) as Account | undefined;
      const stored = account?.password_verifier ?? `${"0".repeat(32)}:${"0".repeat(64)}`;
      if (!await verifyPassword(password, stored) || !account || account.disabled || !this.safetyMatches(account)) throw new AuthenticationError();
      if (account.totp_secret) { const step = validStep(this.unseal(account.totp_secret, account.principal_id), code, this.now(), account.totp_last_step); if (step === undefined) throw new AuthenticationError(); try { this.writeExclusive(join(this.options.stateDirectory,`totp-${account.principal_id}-${step}`),"consumed"); } catch { throw new AuthenticationError(); } const result = this.database.connection.prepare("UPDATE local_accounts SET totp_last_step=? WHERE principal_id=? AND totp_last_step=? AND epoch=?").run(step, account.principal_id, account.totp_last_step, account.epoch); if (result.changes !== 1) throw new AuthenticationError(); }
      const current = this.account(account.principal_id); if (!current || current.epoch !== account.epoch || current.disabled || !this.safetyMatches(current)) throw new AuthenticationError();
      this.database.connection.prepare("DELETE FROM local_auth_attempts WHERE bucket=?").run(digest(`signin:${normalized}`)); this.event(account.principal_id, "signed_in"); return this.issue(current, origin);
    });
  }
  context(token: string, origin: string, administration = true): LocalContext | undefined {
    if (!token || token.length > 100) return undefined;
    const tokenHash = digest(token);
    const session = this.database.connection.prepare("SELECT * FROM local_sessions WHERE token_hash=?").get(tokenHash) as Session | undefined;
    if (!session || session.revoked || existsSync(join(this.options.stateDirectory, `revoked-${tokenHash}`)) || session.origin !== origin) return undefined;
    const account = this.account(session.principal_id), now = this.now();
    if (!account || account.disabled || account.epoch !== session.epoch || !this.safetyMatches(account) || !this.validSessionTime(session, now, administration)) return undefined;
    return Object.freeze({ principalId: account.principal_id, owner: !!account.owner, sessionId: session.session_id, origin,
      expiresAt: new Date(session.admin_last_activity + AUTH_PARAMETERS.adminIdleMs).toISOString(), authenticatedAt: session.authenticated_at, tokenHash });
  }
  private validSessionTime(session: Session, now: number, administration: boolean): boolean {
    return Number.isSafeInteger(now) && now >= 0 && now <= 8_640_000_000_000_000 &&
      Number.isSafeInteger(session.authenticated_at) && Number.isSafeInteger(session.admin_last_activity) &&
      session.authenticated_at >= 0 && session.admin_last_activity <= 8_640_000_000_000_000 - AUTH_PARAMETERS.adminIdleMs &&
      session.authenticated_at <= session.admin_last_activity && now >= session.admin_last_activity &&
      (!administration || now < session.admin_last_activity + AUTH_PARAMETERS.adminIdleMs);
  }
  assertCurrent(context: LocalContext, administration = true): LocalContext {
    const expected = { ...context };
    if (typeof expected.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(expected.tokenHash)) throw new AuthenticationError();
    const session = this.database.connection.prepare("SELECT * FROM local_sessions WHERE token_hash=?").get(expected.tokenHash) as Session | undefined;
    const account = session && this.account(session.principal_id), now = this.now();
    if (!session || session.revoked || existsSync(join(this.options.stateDirectory, `revoked-${expected.tokenHash}`)) || !account || account.disabled ||
      session.epoch !== account.epoch || !this.safetyMatches(account) || !this.validSessionTime(session, now, administration) ||
      expected.principalId !== session.principal_id || expected.sessionId !== session.session_id || expected.origin !== session.origin ||
      expected.authenticatedAt !== session.authenticated_at || expected.owner !== !!account.owner ||
      !Number.isFinite(Date.parse(expected.expiresAt)) || Date.parse(expected.expiresAt) > session.admin_last_activity + AUTH_PARAMETERS.adminIdleMs ||
      (Object.keys(expected) as Array<keyof LocalContext>).some(key => context[key] !== expected[key])) throw new AuthenticationError();
    return context;
  }
  csrf(context: LocalContext, token: string, administration = true): void { this.assertCurrent(context, administration); const session = this.database.connection.prepare("SELECT csrf_hash FROM local_sessions WHERE token_hash=?").get(context.tokenHash) as { csrf_hash: string } | undefined; if (!session || !equal(digest(token), session.csrf_hash)) throw new AuthenticationError(403, "csrf_rejected"); }
  renewCsrf(context: LocalContext): string { this.assertCurrent(context); return createHmac("sha256",this.key).update(`csrf:${context.tokenHash}`).digest("base64url"); }
  touch(context: LocalContext): void { this.assertCurrent(context); this.database.connection.prepare("UPDATE local_sessions SET admin_last_activity=? WHERE token_hash=?").run(this.now(), context.tokenHash); }
  logout(context: LocalContext): void { this.assertCurrent(context, false); const path=join(this.options.stateDirectory,`revoked-${context.tokenHash}`);if(!existsSync(path))this.writeExclusive(path,"revoked");this.database.connection.prepare("UPDATE local_sessions SET revoked=1 WHERE token_hash=?").run(context.tokenHash); this.pendingMfa.delete(context.sessionId); this.event(context.principalId, "signed_out"); }
  async provision(context: LocalContext, username: string, password: string): Promise<{ principalId: string; username: string; owner: false; assistantPermissions: string[] }> { this.assertCurrent(context); if (!context.owner) throw new AuthenticationError(403, "owner_required"); const normalized = normalizeUser(username), encoded = await this.bounded(() => verifier(password)); this.assertCurrent(context); const principalId = randomUUID(); if (this.database.connection.prepare("SELECT principal_id FROM local_accounts WHERE username=?").get(normalized)) throw new AuthenticationError(409, "account_exists"); this.changeCredentials({ principal_id: principalId, username: normalized, owner: 0, password_verifier: encoded, totp_secret: null, totp_last_step: -1, epoch: 1, disabled: 0, created_at: this.now() }, []); this.touch(context); this.event(context.principalId, "account_provisioned"); return { principalId, username: normalized, owner: false, assistantPermissions: [] }; }
  accounts(context: LocalContext): Array<Record<string, unknown>> { this.assertCurrent(context); if (!context.owner) throw new AuthenticationError(403, "owner_required"); return this.database.connection.prepare("SELECT principal_id AS principalId,username,owner,disabled FROM local_accounts ORDER BY username").all() as Array<Record<string, unknown>>; }
  permission(context: LocalContext, principalId: string, assistantId: string, administer: boolean): void { this.assertCurrent(context); if (!context.owner || !this.account(principalId) || !this.database.connection.prepare("SELECT 1 FROM assistant_profiles WHERE assistant_id=?").get(assistantId)) throw new AuthenticationError(403, "permission_assignment_denied"); this.database.connection.prepare("INSERT INTO local_assistant_permissions VALUES (?,?,?) ON CONFLICT(principal_id,assistant_id) DO UPDATE SET administer=excluded.administer").run(principalId, assistantId, Number(administer)); this.touch(context); this.event(context.principalId, "assistant_permission_changed"); }
  permitCreator(context: LocalContext, assistantId: string): void { this.assertCurrent(context); if (!context.owner) throw new AuthenticationError(403, "owner_required"); this.database.connection.prepare("INSERT INTO local_assistant_permissions VALUES (?,?,1)").run(context.principalId, assistantId); }
  canAdminister(context: LocalContext, assistantId: string): boolean { this.assertCurrent(context); return !!this.database.connection.prepare("SELECT 1 FROM local_assistant_permissions WHERE principal_id=? AND assistant_id=? AND administer=1").get(context.principalId, assistantId); }
  async beginMfa(context: LocalContext, password: string): Promise<{ secret: string; uri: string }> { this.assertCurrent(context); this.rate(`mfa:${context.principalId}`); const account = this.account(context.principalId)!; if (account.totp_secret || !await this.bounded(() => verifyPassword(password, account.password_verifier))) throw new AuthenticationError(403, "mfa_enrollment_denied"); this.assertCurrent(context); const secret = encodeBase32(randomBytes(20)); this.pendingMfa.set(context.sessionId, { secret, principalId: context.principalId, until: this.now() + 300_000 }); this.touch(context); return { secret, uri: `otpauth://totp/Lifestream:${encodeURIComponent(account.username)}?secret=${secret}&issuer=Lifestream&algorithm=SHA1&digits=6&period=30` }; }
  confirmMfa(context: LocalContext, code: string): void { this.assertCurrent(context); this.rate(`mfa-confirm:${context.principalId}`); const pending = this.pendingMfa.get(context.sessionId), account = this.account(context.principalId)!; const step = pending && pending.until > this.now() && pending.principalId === context.principalId ? validStep(pending.secret, code, this.now(), -1) : undefined; if (step === undefined || !pending || account.totp_secret) throw new AuthenticationError(403, "mfa_enrollment_denied"); this.changeCredentials({ ...account, totp_secret: this.seal(pending.secret, account.principal_id), totp_last_step: step, epoch: account.epoch + 1 }, this.activeRecoveryHashes(account.principal_id)); this.pendingMfa.delete(context.sessionId); this.event(context.principalId, "mfa_enrolled_sessions_revoked"); }
  async recover(username: string, code: string, newPassword: string, remote: string): Promise<{ recoveryCodes: string[]; signInRequired: true }> {
    const normalized = normalizeUser(username); this.rate(`remote:${remote}`, 40); this.rate(`recover:${normalized}`);
    const account = this.database.connection.prepare("SELECT * FROM local_accounts WHERE username=? AND owner=1").get(normalized) as Account | undefined;
    const codeHash = digest(`${account?.principal_id ?? "unknown"}:${code}`);
    if (!account || account.disabled || !this.safetyMatches(account) || !this.activeRecoveryHashes(account.principal_id).includes(codeHash) || existsSync(join(this.options.stateDirectory, `consumed-${codeHash}`))) throw new AuthenticationError();
    const encoded = await this.bounded(() => verifier(newPassword)); const current = this.account(account.principal_id);
    if (!current || current.epoch !== account.epoch || !this.safetyMatches(current) || !this.activeRecoveryHashes(account.principal_id).includes(codeHash)) throw new AuthenticationError();
    const replacement = opaque(), hashes = this.activeRecoveryHashes(account.principal_id).filter(hash=>hash!==codeHash);
    hashes.push(digest(`${account.principal_id}:${replacement}`));
    this.changeCredentials({ ...account, password_verifier: encoded, totp_secret: null, totp_last_step: -1, epoch: account.epoch + 1 }, hashes);
    if (!existsSync(join(this.options.stateDirectory, `consumed-${codeHash}`))) this.writeExclusive(join(this.options.stateDirectory, `consumed-${codeHash}`), "consumed");
    this.event(account.principal_id, "owner_recovered_sessions_revoked"); return { recoveryCodes: [replacement], signInRequired: true };
  }
  async rotateRecoveryCodes(context: LocalContext, password: string): Promise<string[]> { this.assertCurrent(context); const account=this.account(context.principalId)!; if (!context.owner || !await this.bounded(()=>verifyPassword(password,account.password_verifier))) throw new AuthenticationError(403,"recovery_rotation_denied"); this.assertCurrent(context); const codes=Array.from({length:AUTH_PARAMETERS.recoveryCodeCount},opaque); this.changeCredentials({...account,epoch:account.epoch+1},codes.map(code=>digest(`${account.principal_id}:${code}`))); this.event(context.principalId,"recovery_codes_rotated_sessions_revoked"); return codes; }
  revokeAccount(context: LocalContext, principalId: string): void { this.assertCurrent(context); const account = this.account(principalId); if (!context.owner || !account || account.owner) throw new AuthenticationError(403, "account_revocation_denied"); this.changeCredentials({ ...account, disabled: 1, epoch: account.epoch + 1 }, []); this.touch(context); this.event(context.principalId, "account_revoked"); }
  propose(context: LocalContext, operation: ProposedOperation): { proposalId: string; digest: string; operation: ProposedOperation; status: "proposed" } { this.assertCurrent(context); if (!operation || typeof operation!=="object" || !["POST", "PUT", "PATCH", "DELETE"].includes(operation.method) || !/^\/api\/(admin|authority)\/v1\//.test(operation.path) || operation.path.includes("?") || operation.path.includes("..") || !operation.body || typeof operation.body !== "object" || Array.isArray(operation.body) || !(operation.expectedRevision === null || Number.isInteger(operation.expectedRevision)) || JSON.stringify(operation).length > 32768) throw new AuthenticationError(422, "invalid_proposed_operation"); const proposalId = randomUUID(), hash = operationDigest(operation); this.database.connection.prepare("INSERT INTO local_admin_proposals VALUES (?,?,?,?,?,?,?,NULL)").run(proposalId, context.principalId, context.sessionId, JSON.stringify(operation), hash, this.now(), "proposed"); return { proposalId, digest: hash, operation: structuredClone(operation), status: "proposed" }; }
  review(context: LocalContext, proposalId: string): { operation: ProposedOperation; digest: string; status: string } { this.assertCurrent(context); const proposal = this.database.connection.prepare("SELECT * FROM local_admin_proposals WHERE proposal_id=? AND principal_id=?").get(proposalId, context.principalId) as { session_id: string; operation_json: string; digest: string; status: string; created_at: number } | undefined; if (!proposal || proposal.session_id !== context.sessionId || proposal.created_at + AUTH_PARAMETERS.adminIdleMs <= this.now()) throw new AuthenticationError(409, "proposal_requires_fresh_review"); return { operation: JSON.parse(proposal.operation_json) as ProposedOperation, digest: proposal.digest, status: proposal.status }; }
  approve<T>(context: LocalContext, proposalId: string, reviewedDigest: string, humanConfirmed: boolean, apply: (operation: ProposedOperation) => T): T { const proposal = this.review(context, proposalId); if (!humanConfirmed || proposal.status !== "proposed" || !equal(proposal.digest, reviewedDigest)) throw new AuthenticationError(409, "proposal_changed_or_unapproved"); const result = this.database.connection.prepare("UPDATE local_admin_proposals SET status='consumed',decided_by=? WHERE proposal_id=? AND status='proposed'").run(context.principalId, proposalId); if (result.changes !== 1) throw new AuthenticationError(409, "proposal_already_consumed"); this.touch(context); this.event(context.principalId, "human_proposal_approval_consumed"); return apply(proposal.operation); }
}
