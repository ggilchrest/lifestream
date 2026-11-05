// Generated from producing-owner schema; run scripts/generate-unified-desktop-contracts.mjs.
export type EffectiveSubjectContext = { "schemaVersion": "1.0.0"; "actorId": string; "effectiveUserId": string; "authenticatedSessionId": string; "installationId": string; "authorityRevision": number; "generation": number; "issuedAt": string };
export type EffectiveSubjectError = { "schemaVersion": "1.0.0"; "code": "unauthenticated" | "forbidden" | "scopeChanged" | "notFound" | "unsupportedVersion" | "invalidRequest" | "revisionConflict" | "invalidCursor" | "restartPage" | "unavailable" | "idempotencyConflict" | "backpressure"; "message": string; "retryable": boolean; "correlationId": string };
export type DiscoverUsersRequest = { "schemaVersion": "1.0.0"; "operationId": string; "operation": "discoverUsers"; "expectedGeneration": number; "payload": { "query": string; "pageSize": number; "cursor": (string | null) } };
export type StartContextRequest = { "schemaVersion": "1.0.0"; "operationId": string; "operation": "startContext"; "expectedGeneration": number; "payload": { "targetUserId": string } };
export type SwitchContextRequest = { "schemaVersion": "1.0.0"; "operationId": string; "operation": "switchContext"; "expectedGeneration": number; "payload": { "targetUserId": string } };
export type ReadContextRequest = { "schemaVersion": "1.0.0"; "operationId": string; "operation": "readContext"; "expectedGeneration": number; "payload": {  } };
export type EndContextRequest = { "schemaVersion": "1.0.0"; "operationId": string; "operation": "endContext"; "expectedGeneration": number; "payload": {  } };
export type EffectiveSubjectRequest = (DiscoverUsersRequest | StartContextRequest | SwitchContextRequest | ReadContextRequest | EndContextRequest);
export type AuthorizedUser = { "userId": string; "displayName": string; "isSelf": boolean };
export type AuthorizedUsersPage = { "schemaVersion": "1.0.0"; "users": Array<AuthorizedUser>; "nextCursor": (string | null) };
export type EffectiveSubjectEvent = { "schemaVersion": "1.0.0"; "eventId": string; "eventSequence": number; "context": EffectiveSubjectContext; "occurredAt": string; "type": "contextChanged" | "authorizationRevoked" };
