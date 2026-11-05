// Generated from producing inventory schema; shared records remain owned by mobile-context.
import type {MobileSourceConfiguration,MobileEnrollmentRecord} from './mobile-context.types.ts';
export type MobileInventoryPin = { "schemaId": "https://lifestream.dev/contracts/mobile-context-inventory/1.0.0"; "schemaVersion": "1.0.0"; "digest": string };
export type MobileInventoryRequest = { "schemaVersion": "1.0.0"; "pageSize"?: number; "cursor"?: string };
export type MobileInventorySource = { "sourceNamespace": string; "collector": "healthKit" | "healthConnect"; "policyRevision": number; "configuration": MobileSourceConfiguration; "enrollmentCount": number; "currentEndpointEnrollment": (MobileEnrollmentRecord) | (null); "coverage": { "state": "unknown" } };
export type MobileOwnerInventory = { "principalId": string; "endpointId": string; "sources": (MobileInventorySource)[]; "unboundEnrollments": (MobileEnrollmentRecord)[]; "nextCursor": (string) | (null) };
export type MobileInventoryResponse = { "schemaVersion": "1.0.0"; "producerPin": MobileInventoryPin; "result": MobileOwnerInventory };
